// account.ts
// GET    /export   — structured JSON dump of everything the caller owns,
//                     across every Phase-0 table. docs/candidate-truth-layer
//                     -phase0.md §6 (Export): "a structured (JSON) dump of
//                     everything in §3's Phase-0 table set, scoped to that
//                     candidate_id... should ship in Phase 0, not deferred."
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
import { EVIDENCE_BUCKET } from "../lib/storageClient.js";

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
    ].find((r) => r.error);

    if (firstError?.error) {
      return res.status(400).json({ error: "export_failed", message: firstError.error.message });
    }

    return res.status(200).json({
      exported_at: new Date().toISOString(),
      candidate,
      personal_info: personalInfo.data ?? null,
      consent_records: consentRecords.data,
      education: education.data,
      work_authorization: workAuthorization.data ?? null,
      skills: skills.data,
      projects: projects.data,
      experiences: experiences.data,
      achievements: achievements.data,
      certifications: certifications.data,
      evidence_sources: evidenceSources.data,
      claims: claims.data,
    });
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
    // claim-bearing entities, EvidenceSource, Claim rows themselves."
    // Deleting only public.candidate and leaving auth.users behind would
    // be a WORSE bug than not implementing this at all: the person could
    // still log in, and the 0006_signup_provisioning.sql trigger would
    // silently re-provision a brand-new, empty candidate row on their next
    // authenticated request — an "account that won't stay deleted."
    //
    // Gate 1a: purge Storage-backed evidence files BEFORE the admin
    // cascade below removes the DB rows that reference them. This runs
    // through req.supabase — the caller's own JWT-scoped client, same as
    // everywhere else — not the admin client, so storage.objects RLS
    // (0017_evidence_storage_bucket.sql) is what actually scopes this to
    // the caller's own files. Fetching the paths first (rather than after
    // deleteUser()) matters: once the auth.users row is gone, this same
    // client's JWT is no longer backed by a real user, and the cascade
    // will have already removed the evidence_source rows that hold these
    // paths.
    //
    // Best-effort, same tolerance as evidence-source.ts's own DELETE
    // handler: a Storage failure here should not block account deletion —
    // the account and all DB rows ARE getting deleted either way, and an
    // orphaned Storage object is a cleanup concern, not a security one
    // (nothing can reach it — the candidate row that owned it is gone).
    const { data: filesToDelete, error: filesError } = await supabase
      .from("evidence_source")
      .select("file_ref")
      .eq("source_type", "document_upload")
      .not("file_ref", "is", null);

    if (filesError) {
      console.warn(`account.ts: failed to list evidence files before deletion: ${filesError.message}`);
    } else {
      const paths = (filesToDelete ?? []).map((f) => f.file_ref).filter((p): p is string => !!p);
      if (paths.length > 0) {
        const { error: storageError } = await supabase.storage.from(EVIDENCE_BUCKET).remove(paths);
        if (storageError) {
          console.warn(`account.ts: failed to purge ${paths.length} evidence file(s): ${storageError.message}`);
        }
      }
    }

    const admin = adminClient(env);
    const { error: deleteError } = await admin.auth.admin.deleteUser(userData.user.id);

    if (deleteError) {
      return res.status(400).json({ error: "account_deletion_failed", message: deleteError.message });
    }

    return res.status(204).send();
  });

  return router;
}
