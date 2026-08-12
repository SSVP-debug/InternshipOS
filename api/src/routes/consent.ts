// consent.ts
// POST /consent — grant a consent (data_processing required before profile
//                 use in the client app's own flow; enforced client-side +
//                 by product flow in Phase 0, not yet a DB-level gate).
// GET  /consent  — list the caller's own consent ledger, current + revoked.
//
// Same RLS-scoped pattern as profile.ts — no cross-candidate path exists.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ConsentRequestSchema } from "../lib/schemas.js";
import type { Env } from "../lib/env.js";

export function consentRouter(env: Env): Router {
  const router = Router();

  router.post("/consent", async (req: AuthedRequest, res) => {
    const parsed = ConsentRequestSchema.safeParse(req.body);
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

    const { error: insertError } = await supabase.from("consent_record").insert({
      candidate_id: candidate.id,
      consent_type: parsed.data.consent_type,
      version: env.CONSENT_POLICY_VERSION,
    });

    if (insertError) {
      // Unique-active-consent-per-type violations surface here as a 409,
      // matching the DB constraint from 0004_consent_record.sql.
      const isDuplicate = insertError.message.includes("uq_consent_active_per_type");
      return res
        .status(isDuplicate ? 409 : 400)
        .json({ error: isDuplicate ? "consent_already_active" : "consent_failed", message: insertError.message });
    }

    return res.status(201).json({ message: "consent recorded" });
  });

  router.get("/consent", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("consent_record")
      .select("consent_type, granted_at, revoked_at, version")
      .order("granted_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "consent_fetch_failed", message: error.message });
    }
    return res.status(200).json({ consents: data });
  });

  return router;
}
