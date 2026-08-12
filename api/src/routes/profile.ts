// profile.ts
// GET  /profile  — returns the caller's own candidate + personal_info (or
//                  404 if personal_info hasn't been set yet).
// POST /profile  — upserts the caller's own personal_info.
//
// Every query here runs through req.supabase — the user-scoped client from
// the auth middleware — so Postgres RLS is what actually prevents a caller
// from reading or writing anyone else's data. This route intentionally does
// NOT pass a candidate_id from the client; it looks up "my own candidate
// row" via the authenticated user, so there's no way to pass someone else's
// id and have the request even attempt cross-candidate access.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { PersonalInfoRequestSchema } from "../lib/schemas.js";

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

  router.post("/profile", async (req: AuthedRequest, res) => {
    const parsed = PersonalInfoRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase
      .from("candidate")
      .select("id")
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

    return res.status(200).json({ message: "profile updated" });
  });

  return router;
}
