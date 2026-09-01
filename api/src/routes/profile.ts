// profile.ts
// GET   /profile         — returns the caller's own candidate + personal_info
//                           (or 404 if personal_info hasn't been set yet).
//                           Not gated by consent — reading your own
//                           already-stored data is always allowed,
//                           regardless of current consent state.
// POST  /profile         — upserts the caller's own personal_info. Gated by
//                           requireConsent("data_processing"): the caller
//                           must have an active (unrevoked) data_processing
//                           consent_record, or the request is rejected with
//                           403 before any write is attempted. This mirrors
//                           the RLS-level gate added in
//                           0014_consent_gate_personal_info.sql, which is
//                           the authoritative enforcement — this middleware
//                           is the fail-fast API-layer half. On a
//                           successful save, also auto-activates
//                           profile_status the first time (see the handler
//                           for why).
// PATCH /profile/status  — candidate-initiated profile_status transition
//                           (active <-> paused, or either -> archived).
//                           See the handler for the transition rules.
//
// Every query here runs through req.supabase — the user-scoped client from
// the auth middleware — so Postgres RLS is what actually prevents a caller
// from reading or writing anyone else's data. This route intentionally does
// NOT pass a candidate_id from the client; it looks up "my own candidate
// row" via the authenticated user, so there's no way to pass someone else's
// id and have the request even attempt cross-candidate access.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireConsent } from "../middleware/requireConsent.js";
import { PersonalInfoRequestSchema, ProfileStatusUpdateSchema } from "../lib/schemas.js";

export function profileRouter(): Router {
  const router = Router();

  router.get("/profile", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase
      .from("candidate")
      .select("id, profile_status, created_at")
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const { data: personalInfo } = await supabase
      .from("personal_info")
      .select("legal_first_name, legal_last_name, preferred_name, email, phone, location_city, location_country, pronouns")
      .eq("candidate_id", candidate.id)
      .maybeSingle();

    return res.status(200).json({ candidate, personal_info: personalInfo ?? null });
  });

  router.post("/profile", requireConsent("data_processing"), async (req: AuthedRequest, res) => {
    const parsed = PersonalInfoRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase
      .from("candidate")
      .select("id, profile_status")
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const { error: upsertError } = await supabase
      .from("personal_info")
      .upsert({ candidate_id: candidate.id, ...parsed.data }, { onConflict: "candidate_id" });

    if (upsertError) {
      return res.status(400).json({ error: "profile_update_failed", message: upsertError.message });
    }

    // A candidate's first successful personal_info save is the first real
    // signal that they're actually using the product, not just holding an
    // account that was auto-provisioned at signup (0006_signup_provisioning.sql
    // sets profile_status = 'incomplete' once, and nothing else in this
    // codebase ever wrote to it before this). This is the natural,
    // already-consent-gated place to leave 'incomplete' behind.
    //
    // Only fires from 'incomplete' specifically: a candidate who has since
    // explicitly paused or archived their profile (see PATCH
    // /profile/status below) keeps editing personal_info without this
    // silently reactivating them — that would defeat the entire point of
    // adding a pause/archive control in the first place.
    //
    // Non-fatal by design: the profile write above already succeeded, so a
    // failure here is not surfaced to the caller as a request failure. The
    // only consequence of profile_status staying 'incomplete' a little
    // longer than ideal is that this candidate keeps being matched under
    // the existing sparse-data tolerance (see
    // runMatchingForActiveCandidates.ts) — never a correctness or
    // access-control issue.
    if (candidate.profile_status === "incomplete") {
      await supabase.from("candidate").update({ profile_status: "active" }).eq("id", candidate.id);
    }

    return res.status(200).json({ message: "profile updated" });
  });

  router.patch("/profile/status", async (req: AuthedRequest, res) => {
    const parsed = ProfileStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase
      .from("candidate")
      .select("id, profile_status")
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // 'archived' is terminal through this endpoint. Without this guard, a
    // PATCH here would make 'archived' just a second, reversible flavor of
    // 'paused' — indistinguishable from it in practice. The only way back
    // into the product from 'archived' is DELETE /account followed by a
    // fresh signup, which is a deliberate, considered action rather than a
    // one-field toggle.
    if (candidate.profile_status === "archived") {
      return res.status(409).json({
        error: "profile_archived",
        message: "This profile is archived and cannot change status. Delete the account to start over.",
      });
    }

    const nextStatus = parsed.data.profile_status;

    if (candidate.profile_status === nextStatus) {
      return res.status(200).json({ message: "profile status unchanged", profile_status: nextStatus });
    }

    const { error: updateError } = await supabase
      .from("candidate")
      .update({ profile_status: nextStatus })
      .eq("id", candidate.id);

    if (updateError) {
      return res.status(400).json({ error: "profile_status_update_failed", message: updateError.message });
    }

    return res.status(200).json({ message: "profile status updated", profile_status: nextStatus });
  });

  return router;
}
