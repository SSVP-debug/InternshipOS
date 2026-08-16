// claim.ts
// GET   /claims             — list the caller's own claims
// GET   /claims/:id         — get one of the caller's own claims
// POST  /claims             — create a claim (always starts as DRAFT)
// PUT   /claims/:id         — update claim_text/evidence_source_id/subject
//                             (does NOT touch status — see below)
// PATCH /claims/:id/status  — the only way to move a claim through the
//                             ClaimStatus lifecycle
//
// No DELETE route — claims are never deleted (0016_claim.sql has no
// DELETE RLS policy at all, so a delete attempt is denied by the database
// regardless of what this API does; there is deliberately no route here
// either, so the "claims are permanent" rule is visible at the API surface
// too, not just enforced silently at the RLS layer).
//
// Status changes are split into their own endpoint rather than folded into
// PUT so the ClaimStatus state machine has exactly one entry point at the
// API layer — mirroring the single DB trigger
// (check_claim_status_transition) that is the actual source of truth for
// which transitions are legal. This route does not duplicate that
// transition logic; it just forwards the requested status and lets the
// trigger accept or reject it.
//
// Same ownership pattern as every other Day 2/3 route: every query runs
// through req.supabase (the caller's own JWT), so RLS — not this code —
// prevents reading/writing another candidate's claims.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ClaimRequestSchema, ClaimStatusTransitionSchema, UuidParamSchema } from "../lib/schemas.js";

const CLAIM_COLUMNS =
  "id, subject_entity_type, subject_entity_id, claim_text, status, evidence_source_id, " +
  "superseded_by_claim_id, last_reviewed_at, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

// Postgres check_violation, raised by check_claim_status_transition() for
// any transition not in the approved ClaimStatus table.
const CHECK_VIOLATION = "23514";

export function claimRouter(): Router {
  const router = Router();

  router.get("/claims", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("claim")
      .select(CLAIM_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "claim_fetch_failed", message: error.message });
    }
    return res.status(200).json({ claims: data });
  });

  router.get("/claims/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("claim")
      .select(CLAIM_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "claim_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "claim_not_found" });
    }
    return res.status(200).json({ claim: data });
  });

  router.post("/claims", async (req: AuthedRequest, res) => {
    const parsed = ClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    // status is intentionally omitted — the column default ('DRAFT')
    // applies, matching the doc: every claim starts as DRAFT regardless
    // of how it was created (manual entry or auto-suggested).
    const { data, error } = await supabase
      .from("claim")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(CLAIM_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "claim_create_failed", message: error.message });
    }
    return res.status(201).json({ claim: data });
  });

  router.put("/claims/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("claim")
      .update(parsed.data) // never includes `status` — ClaimRequestSchema has no status field
      .eq("id", idParsed.data)
      .select(CLAIM_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "claim_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "claim_not_found" });
    }
    return res.status(200).json({ claim: data });
  });

  router.patch("/claims/:id/status", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ClaimStatusTransitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("claim")
      .update({ status: parsed.data.status })
      .eq("id", idParsed.data)
      .select(CLAIM_COLUMNS)
      .maybeSingle();

    if (error) {
      const isIllegalTransition = error.code === CHECK_VIOLATION;
      return res.status(isIllegalTransition ? 409 : 400).json({
        error: isIllegalTransition ? "invalid_status_transition" : "claim_status_update_failed",
        message: error.message,
      });
    }
    if (!data) {
      return res.status(404).json({ error: "claim_not_found" });
    }
    return res.status(200).json({ claim: data });
  });

  return router;
}
