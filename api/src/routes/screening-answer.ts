// screening-answer.ts
// GET    /screening-answers      — list the caller's own screening Q&A entries
// GET    /screening-answers/:id  — get one of the caller's own entries
// POST   /screening-answers      — create an entry for the caller
// PUT    /screening-answers/:id  — full update of one of the caller's own entries
// DELETE /screening-answers/:id  — delete one of the caller's own entries
//
// Same pattern as education.ts: every query runs through req.supabase
// (the caller's own JWT), so Postgres RLS — not this code — is what
// prevents reading/writing another candidate's entries.
//
// IMPORTANT: this is a reference library only. Nothing here is read by
// attemptAtsSubmission.ts or any other submission path — see
// 0031_screening_answer.sql's own header for why (no reliable way to
// discover a real posting's actual custom-question schema to match
// against). If that ever changes, wiring auto-fill is a separate,
// later decision — this route doesn't imply or prepare for it beyond
// being a place the data could eventually be read from.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ScreeningAnswerRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const SCREENING_ANSWER_COLUMNS = "id, question, answer, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function screeningAnswerRouter(): Router {
  const router = Router();

  router.get("/screening-answers", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("screening_answer")
      .select(SCREENING_ANSWER_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "screening_answer_fetch_failed", message: error.message });
    }
    return res.status(200).json({ screening_answers: data });
  });

  router.get("/screening-answers/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("screening_answer")
      .select(SCREENING_ANSWER_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "screening_answer_fetch_failed", message: error.message });
    }
    // RLS guarantees this is either the caller's own row or no row at
    // all — a foreign id resolves to not-found, never another
    // candidate's data.
    if (!data) {
      return res.status(404).json({ error: "screening_answer_not_found" });
    }
    return res.status(200).json({ screening_answer: data });
  });

  router.post("/screening-answers", async (req: AuthedRequest, res) => {
    const parsed = ScreeningAnswerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("screening_answer")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(SCREENING_ANSWER_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "screening_answer_create_failed", message: error.message });
    }

    return res.status(201).json({ screening_answer: data });
  });

  router.put("/screening-answers/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ScreeningAnswerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("screening_answer")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(SCREENING_ANSWER_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "screening_answer_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which
    // surfaces identically to "id doesn't exist" — no information leak
    // either way.
    if (!data) {
      return res.status(404).json({ error: "screening_answer_not_found" });
    }
    return res.status(200).json({ screening_answer: data });
  });

  router.delete("/screening-answers/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("screening_answer")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "screening_answer_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "screening_answer_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
