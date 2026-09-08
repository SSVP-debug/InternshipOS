// account.ts
// GET    /export   — a readable PDF document of everything the caller
//                     owns, across every Phase-0 (and Phase 1) table.
//                     docs/candidate-truth-layer-phase0.md §6 (Export)
//                     originally called for "a structured (JSON) dump of
//                     everything in §3's Phase-0 table set" for data
//                     portability; this now renders that same query
//                     result as a PDF instead, per direct product
//                     decision — the candidate wants a document to read,
//                     not a machine-readable file. See pdfExport.ts for
//                     the rendering; nothing about which tables are
//                     queried, or their RLS scoping, changed.
// DELETE /account  — real, destructive, cascading deletion. §6 (Deletion):
//                     "Deletion is destructive, not a soft archived flag."
//
// Both routes are read/act on "my own data only" with no id taken from the
// client, same convention as profile.ts — there's no parameter to swap out
// to reach someone else's account.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import type { Env } from "../lib/env.js";
import { adminClient } from "../lib/supabaseClient.js";
import { buildExportPdf } from "../lib/pdfExport.js";
import { reqLogger } from "../middleware/requestLogger.js";

export function accountRouter(env: Env): Router {
  const router = Router();

  router.get("/export", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase
      .from("candidate")
      .select("id, profile_status, created_at, updated_at, data_retention_ack_at")
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // Every query below runs through the same RLS-scoped client, so this
    // can only ever return the caller's own rows — the explicit
    // .eq("candidate_id", ...) is redundant with RLS but kept for
    // readability (this handler is a checklist against §3's table set,
    // and the filter makes that checklist legible at a glance).
    const candidateId = candidate.id;

    const [
      personalInfo,
      consentRecords,
      education,
      workAuthorization,
      skills,
      projects,
      experiences,
      achievements,
      certifications,
      evidenceSources,
      claims,
      opportunities,
      applications,
      applicationStatusEvents,
      applicationNotes,
    ] = await Promise.all([
      supabase.from("personal_info").select("*").eq("candidate_id", candidateId).maybeSingle(),
      supabase.from("consent_record").select("*").eq("candidate_id", candidateId),
      supabase.from("education").select("*").eq("candidate_id", candidateId),
      supabase.from("work_authorization").select("*").eq("candidate_id", candidateId).maybeSingle(),
      supabase.from("skill").select("*").eq("candidate_id", candidateId),
      supabase.from("project").select("*").eq("candidate_id", candidateId),
      supabase.from("experience").select("*").eq("candidate_id", candidateId),
      supabase.from("achievement").select("*").eq("candidate_id", candidateId),
      supabase.from("certification").select("*").eq("candidate_id", candidateId),
      supabase.from("evidence_source").select("*").eq("candidate_id", candidateId),
      supabase.from("claim").select("*").eq("candidate_id", candidateId),
      // Phase 1 tables — same "scoped to caller via RLS + explicit .eq
      // for readability" pattern as every table above.
      supabase.from("opportunity").select("*").eq("candidate_id", candidateId),
      supabase.from("application").select("*").eq("candidate_id", candidateId),
      supabase.from("application_status_event").select("*").eq("candidate_id", candidateId),
      supabase.from("application_note").select("*").eq("candidate_id", candidateId),
    ]);

    const firstError = [
      personalInfo,
      consentRecords,
      education,
      workAuthorization,
      skills,
      projects,
      experiences,
      achievements,
      certifications,
      evidenceSources,
      claims,
      opportunities,
      applications,
      applicationStatusEvents,
      applicationNotes,
    ].find((r) => r.error);

    if (firstError?.error) {
      return res.status(400).json({ error: "export_failed", message: firstError.error.message });
    }

    // buildExportPdf ends the document synchronously (see pdfExport.ts),
    // but it's still a stream — piping happens after headers are set,
    // same order as any other Node response stream.
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="internshipos-export.pdf"');
    const pdf = buildExportPdf({
      exported_at: new Date().toISOString(),
      candidate,
      personal_info: personalInfo.data ?? null,
      consent_records: consentRecords.data ?? [],
      education: education.data ?? [],
      work_authorization: workAuthorization.data ?? null,
      skills: skills.data ?? [],
      projects: projects.data ?? [],
      experiences: experiences.data ?? [],
      achievements: achievements.data ?? [],
      certifications: certifications.data ?? [],
      evidence_sources: evidenceSources.data ?? [],
      claims: claims.data ?? [],
      opportunities: opportunities.data ?? [],
      applications: applications.data ?? [],
      application_status_events: applicationStatusEvents.data ?? [],
      application_notes: applicationNotes.data ?? [],
    });
    pdf.on("error", (err) => {
      reqLogger(req).error({ err }, "export_pdf_stream_failed");
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    pdf.pipe(res);
  });

  router.delete("/account", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    // Resolve the caller's own auth.users id from their own access token —
    // never taken from a request parameter, same "no id to swap out"
    // discipline as everywhere else in this API.
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    // This is the SECOND (and only other) use of the admin/service_role
    // client in this API, alongside signup.ts's account creation. Deleting
    // the auth.users row — not just the public.candidate row — is
    // deliberate: candidate.auth_user_id references auth.users(id) on
    // delete cascade (0002_candidate.sql), and every domain table
    // references candidate(id) on delete cascade in turn, so this single
    // admin call cascades through the ENTIRE Phase-0 table set (personal_
    // info, consent_record, education, work_authorization, skill, project,
    // experience, achievement, certification, evidence_source, claim) —
    // matching §6's "Deletion cascades: PersonalInfo, Education, all
    // claim-bearing entities, EvidenceSource, Claim rows themselves." —
    // AND, as of Phase 1, the same cascade chain also removes opportunity,
    // application, application_status_event, and application_note
    // (0017-0020), since those tables also reference candidate(id) on
    // delete cascade. See tests/rls/test_account_deletion_cascade.sql,
    // extended in Phase 1 to assert this across all 15 tables together.
    // Deleting only public.candidate and leaving auth.users behind would
    // be a WORSE bug than not implementing this at all: the person could
    // still log in, and the 0006_signup_provisioning.sql trigger would
    // silently re-provision a brand-new, empty candidate row on their next
    // authenticated request — an "account that won't stay deleted."
    //
    // KNOWN GAP: this does not purge any files from Supabase Storage that
    // an EvidenceSource.file_ref might point to. §6 says deletion should
    // include "EvidenceSource (including stored files)", but no file
    // upload flow exists in this repo yet (evidence-source.ts only stores
    // a file_ref path string; nothing currently writes to Storage) — so
    // there is no bucket/convention to purge against yet. This needs to be
    // revisited when the actual upload endpoint is built, not invented
    // here ahead of it.
    const admin = adminClient(env);
    const { error: deleteError } = await admin.auth.admin.deleteUser(userData.user.id);

    if (deleteError) {
      return res.status(400).json({ error: "account_deletion_failed", message: deleteError.message });
    }

    return res.status(204).send();
  });

  return router;
}
