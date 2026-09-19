// attemptAtsSubmission.ts
//
// ⚠️ The submission call this makes (via leverAdapter.ts's
// submitLeverApplication) does not actually work against a real Lever
// posting — it requires an employer-issued API key this code never
// supplies. See leverAdapter.ts's header and
// docs/gate-r8-lever-ats-submission.md's 2026-09-19 correction notice
// for the full story before assuming anything below this comment
// results in a real submission.
//
// The actual work behind POST /applications/:id/submit-to-ats, pulled out
// of that route so the new bulk route (POST
// /opportunity-matches/bulk-submit-to-ats) can call the exact same code
// path per application instead of a second, drifting copy of ~180 lines
// of eligibility checks. Both routes are now thin: parse input, resolve
// an application id, call this, map the outcome to a response.
//
// Deliberately returns a plain discriminated-union outcome rather than
// touching `res` directly — that's what makes it callable from a loop
// (the bulk route) as easily as from a single request (the original
// route), and keeps this file free of any Express-specific types.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLeverPostingUrl, getLeverPosting, submitLeverApplication } from "./leverAdapter.js";

const EVIDENCE_BUCKET = "evidence-documents";
const DOWNLOAD_URL_EXPIRY_SECONDS = 60; // short-lived — used immediately, server-side, never returned to a client

export interface AtsApplicationRow {
  id: string;
  opportunity_id: string;
  resume_id: string | null;
  status: string;
  ats_provider: string | null;
  ats_external_id: string | null;
  ats_submitted_at: string | null;
  ats_submission_error: string | null;
  [key: string]: unknown; // callers select more columns (APPLICATION_COLUMNS); this function only reads the fields above
}

export interface WouldSubmitPreview {
  site: string;
  posting_id: string;
  posting_title: string;
  name: string;
  email: string;
  phone?: string;
  comments?: string;
  resume_title: string;
}

export type AtsSubmissionOutcome =
  | { kind: "rejected"; httpStatus: number; error: string; message?: string }
  | { kind: "dry_run"; would_submit: WouldSubmitPreview }
  | { kind: "submitted"; application: AtsApplicationRow; warning?: string }
  | { kind: "submission_failed"; message: string };

/** Runs every precondition check POST /applications/:id/submit-to-ats has
 * always run, then — only if dryRun is false and every check passed —
 * actually submits to Lever and advances the application's status. See
 * docs/gate-r8-lever-ats-submission.md for the full behavior/limits this
 * implements; this function's job is just to BE that behavior in one
 * place, not to re-explain it — see that route's/doc's comments for why
 * each check exists. */
export async function attemptAtsSubmission(
  supabase: SupabaseClient,
  candidateId: string,
  applicationId: string,
  options: { dryRun: boolean; comments?: string },
  applicationColumns: string,
): Promise<AtsSubmissionOutcome> {
  const { data: applicationRaw, error: applicationError } = await supabase
    .from("application")
    .select("id, status, resume_id, opportunity_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (applicationError) {
    return { kind: "rejected", httpStatus: 400, error: "application_fetch_failed", message: applicationError.message };
  }
  if (!applicationRaw) {
    return { kind: "rejected", httpStatus: 404, error: "application_not_found" };
  }
  const application = applicationRaw as unknown as Pick<AtsApplicationRow, "id" | "status" | "resume_id" | "opportunity_id">;

  if (application.status !== "SAVED" && application.status !== "APPLYING") {
    return {
      kind: "rejected",
      httpStatus: 409,
      error: "application_not_eligible_for_submission",
      message: `Application status is ${application.status}; only SAVED or APPLYING applications can be auto-submitted.`,
    };
  }

  if (!application.resume_id) {
    return { kind: "rejected", httpStatus: 422, error: "no_resume_selected", message: "This application has no resume_id set." };
  }

  const [opportunityResult, resumeResult, personalInfoResult] = await Promise.all([
    supabase.from("opportunity").select("id, application_url").eq("id", application.opportunity_id).maybeSingle(),
    supabase.from("resume").select("id, evidence_source_id").eq("id", application.resume_id).maybeSingle(),
    supabase.from("personal_info").select("legal_first_name, legal_last_name, email, phone").maybeSingle(),
  ]);
  if (opportunityResult.error || resumeResult.error || personalInfoResult.error) {
    const firstError = opportunityResult.error ?? resumeResult.error ?? personalInfoResult.error;
    return { kind: "rejected", httpStatus: 400, error: "application_fetch_failed", message: firstError!.message };
  }

  const opportunity = opportunityResult.data as { id: string; application_url: string | null } | null;
  if (!opportunity?.application_url) {
    return { kind: "rejected", httpStatus: 422, error: "opportunity_missing_application_url" };
  }

  const leverRef = parseLeverPostingUrl(opportunity.application_url);
  if (!leverRef) {
    return {
      kind: "rejected",
      httpStatus: 422,
      error: "unsupported_ats",
      message: "Auto-submission currently only supports Lever-hosted postings (jobs.lever.co/...).",
    };
  }

  const resume = resumeResult.data as { id: string; evidence_source_id: string | null } | null;
  if (!resume?.evidence_source_id) {
    return {
      kind: "rejected",
      httpStatus: 422,
      error: "resume_missing_file",
      message: "The selected resume has no attached document — nothing to submit as a resume file.",
    };
  }

  const { data: evidenceSourceRaw, error: evidenceSourceError } = await supabase
    .from("evidence_source")
    .select("source_type, file_ref, title")
    .eq("id", resume.evidence_source_id)
    .maybeSingle();
  if (evidenceSourceError) {
    return { kind: "rejected", httpStatus: 400, error: "application_fetch_failed", message: evidenceSourceError.message };
  }
  const evidenceSource = evidenceSourceRaw as { source_type: string; file_ref: string | null; title: string } | null;
  if (!evidenceSource || evidenceSource.source_type !== "document_upload" || !evidenceSource.file_ref) {
    return {
      kind: "rejected",
      httpStatus: 422,
      error: "resume_missing_file",
      message: "The selected resume's evidence source is not an uploaded document.",
    };
  }

  const personalInfo = personalInfoResult.data as
    | { legal_first_name: string; legal_last_name: string; email: string; phone: string | null }
    | null;
  if (!personalInfo?.legal_first_name || !personalInfo.legal_last_name || !personalInfo.email) {
    return {
      kind: "rejected",
      httpStatus: 422,
      error: "personal_info_incomplete",
      message: "Legal name and email must be filled in under Profile before auto-submitting an application.",
    };
  }

  const postingResult = await getLeverPosting(leverRef);
  if (!postingResult.ok) {
    return { kind: "rejected", httpStatus: 422, error: "ats_posting_unavailable", message: postingResult.message };
  }
  if (postingResult.posting.state !== "published") {
    return {
      kind: "rejected",
      httpStatus: 422,
      error: "opportunity_closed",
      message: `This posting's current state on Lever is "${postingResult.posting.state}", not "published".`,
    };
  }

  const wouldSubmit: WouldSubmitPreview = {
    site: leverRef.site,
    posting_id: leverRef.postingId,
    posting_title: postingResult.posting.text,
    name: `${personalInfo.legal_first_name} ${personalInfo.legal_last_name}`,
    email: personalInfo.email,
    phone: personalInfo.phone ?? undefined,
    comments: options.comments ?? undefined,
    resume_title: evidenceSource.title,
  };

  if (options.dryRun) {
    return { kind: "dry_run", would_submit: wouldSubmit };
  }

  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(evidenceSource.file_ref, DOWNLOAD_URL_EXPIRY_SECONDS);
  if (signedUrlError || !signedUrlData) {
    return {
      kind: "rejected",
      httpStatus: 502,
      error: "resume_file_unavailable",
      message: signedUrlError?.message ?? "Could not create a signed URL for the resume file.",
    };
  }

  let resumeBytes: ArrayBuffer;
  let resumeContentType: string;
  try {
    const fileResponse = await fetch(signedUrlData.signedUrl);
    if (!fileResponse.ok) throw new Error(`storage download returned ${fileResponse.status}`);
    resumeBytes = await fileResponse.arrayBuffer();
    resumeContentType = fileResponse.headers.get("content-type") ?? "application/octet-stream";
  } catch (err) {
    return {
      kind: "rejected",
      httpStatus: 502,
      error: "resume_file_download_failed",
      message: err instanceof Error ? err.message : "unknown error downloading resume file",
    };
  }

  const filename = evidenceSource.file_ref.split("/").pop() ?? "resume";
  const submitResult = await submitLeverApplication(leverRef, {
    name: wouldSubmit.name,
    email: wouldSubmit.email,
    phone: wouldSubmit.phone,
    comments: wouldSubmit.comments,
    resumeFile: { bytes: resumeBytes, filename, contentType: resumeContentType },
  });

  if (!submitResult.ok) {
    await supabase.from("application").update({ ats_submission_error: submitResult.message }).eq("id", application.id);
    return { kind: "submission_failed", message: submitResult.message };
  }

  let currentStatus = application.status;
  if (currentStatus === "SAVED") {
    await supabase.from("application").update({ status: "APPLYING" }).eq("id", application.id);
    await supabase.from("application_status_event").insert({
      application_id: application.id,
      candidate_id: candidateId,
      from_status: "SAVED",
      to_status: "APPLYING",
      note: "Auto-advanced by submit-to-ats before external submission.",
    });
    currentStatus = "APPLYING";
  }

  const { data: finalRaw, error: finalError } = await supabase
    .from("application")
    .update({ status: "APPLIED", ats_provider: "lever", ats_submitted_at: new Date().toISOString(), ats_submission_error: null })
    .eq("id", application.id)
    .select(applicationColumns)
    .maybeSingle();
  if (finalError || !finalRaw) {
    // Lever already accepted the submission — this is only our own
    // tracking update failing, so it must not come back as
    // "submission_failed" (a caller retrying on that could double-apply).
    // "submitted" with a best-effort application object is the honest
    // shape here: the submission itself is real regardless of whether
    // this particular status write landed.
    return {
      kind: "submitted",
      application: { ...application, status: "APPLIED", ats_provider: "lever", ats_submitted_at: new Date().toISOString(), ats_submission_error: null } as AtsApplicationRow,
      warning: "Submitted to Lever successfully, but updating this application's tracked status failed: " + (finalError?.message ?? "unknown error"),
    };
  }

  await supabase.from("application_status_event").insert({
    application_id: application.id,
    candidate_id: candidateId,
    from_status: currentStatus,
    to_status: "APPLIED",
    note: "Submitted via Lever (submit-to-ats).",
  });

  return { kind: "submitted", application: finalRaw as unknown as AtsApplicationRow };
}
