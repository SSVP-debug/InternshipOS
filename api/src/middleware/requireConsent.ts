// requireConsent.ts
// Express middleware: blocks a request unless the caller has an active
// (unrevoked) consent_record of the given type. This is the API-layer half
// of the consent gate — belt-and-braces alongside the database-level
// enforcement in 0014_consent_gate_personal_info.sql, which is the
// authoritative layer (RLS can't be bypassed by an API bug; this middleware
// exists to fail fast with a clear error before ever reaching Postgres).
//
// Applied per-route, not globally, because different actions require
// different consent types (e.g. profile writes need data_processing;
// a future GitHub import would need github_oauth_access). See
// api/src/routes/profile.ts for the current usage on POST /profile.
//
// Like every other route in this API, this runs through req.supabase — the
// user-scoped client from the auth middleware — so it can only ever see
// the caller's own candidate/consent rows; there is no cross-candidate path.

import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth.js";
import type { ConsentRequest } from "../lib/schemas.js";

type ConsentType = ConsentRequest["consent_type"];

export function requireConsent(consentType: ConsentType) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase
      .from("candidate")
      .select("id")
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const { data: consent, error: consentError } = await supabase
      .from("consent_record")
      .select("id")
      .eq("candidate_id", candidate.id)
      .eq("consent_type", consentType)
      .is("revoked_at", null)
      .maybeSingle();

    if (consentError) {
      return res.status(400).json({ error: "consent_check_failed", message: consentError.message });
    }

    if (!consent) {
      return res.status(403).json({ error: "consent_required", consent_type: consentType });
    }

    next();
  };
}
