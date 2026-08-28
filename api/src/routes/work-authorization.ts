// work-authorization.ts
// GET  /work-authorization  — returns the caller's own current WorkAuthorization
//                              record, or `{ work_authorization: null }` (HTTP 200)
//                              if none has been set yet. Mirrors profile.ts's
//                              GET /profile pattern exactly: a missing optional
//                              singleton is a normal, successful "empty" result,
//                              not a 404. (Previously this returned 404 for the
//                              missing case — a genuine bug: the frontend's own
//                              types/logic always expected `work_authorization:
//                              WorkAuthorization | null` in a 200 response, and
//                              the 404 surfaced literally as the error text
//                              "work_authorization_not_found" on screen instead
//                              of rendering an empty form. Fixed to match the
//                              established singleton convention.)
// POST /work-authorization  — CREATE the caller's WorkAuthorization record.
//                              409 if one already exists (use PUT to update).
// PUT  /work-authorization  — UPDATE the caller's existing WorkAuthorization
//                              record. 404 if none exists yet (use POST to create).
//                              This 404 is a genuine "update target doesn't
//                              exist" business error, not the same case as GET's
//                              — it is intentionally unchanged.
//
// Distinct POST/PUT semantics (rather than personal_info's single upsert)
// because this task calls out "valid creation" and "update" as separate,
// individually testable behaviors. Functionally this is still a single
// current-state row per candidate — candidate_id is the primary key
// (0008_work_authorization.sql), so a second POST can never silently
// create a duplicate.
//
// Same RLS-scoped pattern as profile.ts/education.ts: every query runs
// through req.supabase (the caller's own JWT), so ownership is enforced by
// Postgres, not by this code.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { WorkAuthorizationRequestSchema } from "../lib/schemas.js";

const WORK_AUTH_COLUMNS =
  "candidate_id, citizenship_country, status, requires_sponsorship, " +
  "work_auth_expiry_date, notes, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function workAuthorizationRouter(): Router {
  const router = Router();

  router.get("/work-authorization", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("work_authorization")
      .select(WORK_AUTH_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "work_authorization_fetch_failed", message: error.message });
    }
    // No row yet is a normal, successful empty state — same convention as
    // GET /profile's `personal_info: null` — not a 404.
    return res.status(200).json({ work_authorization: data ?? null });
  });

  router.post("/work-authorization", async (req: AuthedRequest, res) => {
    const parsed = WorkAuthorizationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("work_authorization")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(WORK_AUTH_COLUMNS)
      .single();

    if (error) {
      const isDuplicate = error.code === "23505"; // primary key violation on candidate_id
      return res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate ? "work_authorization_already_exists" : "work_authorization_create_failed",
        message: error.message,
      });
    }

    return res.status(201).json({ work_authorization: data });
  });

  router.put("/work-authorization", async (req: AuthedRequest, res) => {
    const parsed = WorkAuthorizationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("work_authorization")
      .update(parsed.data)
      .eq("candidate_id", candidateId)
      .select(WORK_AUTH_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "work_authorization_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "work_authorization_not_found" });
    }
    return res.status(200).json({ work_authorization: data });
  });

  return router;
}
