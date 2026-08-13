// skill.ts
// GET    /skills      — list the caller's own skills
// GET    /skills/:id  — get one of the caller's own skills
// POST   /skills      — create a skill for the caller
// PUT    /skills/:id  — update one of the caller's own skills
// DELETE /skills/:id  — delete one of the caller's own skills
//
// Same pattern as education.ts: every query runs through req.supabase (the
// caller's own JWT), so Postgres RLS — not this code — is what prevents
// reading/writing another candidate's skills. A foreign id resolves to
// not-found, never another candidate's data.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { SkillRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const SKILL_COLUMNS =
  "id, name, category, self_rating, evidence_backed, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function skillRouter(): Router {
  const router = Router();

  router.get("/skills", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("skill")
      .select(SKILL_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "skill_fetch_failed", message: error.message });
    }
    return res.status(200).json({ skills: data });
  });

  router.get("/skills/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("skill")
      .select(SKILL_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "skill_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "skill_not_found" });
    }
    return res.status(200).json({ skill: data });
  });

  router.post("/skills", async (req: AuthedRequest, res) => {
    const parsed = SkillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("skill")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(SKILL_COLUMNS)
      .single();

    if (error) {
      const isDuplicate = error.code === "23505"; // uq_skill_candidate_name_normalized
      return res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate ? "skill_already_exists" : "skill_create_failed",
        message: error.message,
      });
    }

    return res.status(201).json({ skill: data });
  });

  router.put("/skills/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = SkillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("skill")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(SKILL_COLUMNS)
      .maybeSingle();

    if (error) {
      const isDuplicate = error.code === "23505";
      return res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate ? "skill_already_exists" : "skill_update_failed",
        message: error.message,
      });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "skill_not_found" });
    }
    return res.status(200).json({ skill: data });
  });

  router.delete("/skills/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("skill")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "skill_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "skill_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
