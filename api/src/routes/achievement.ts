// achievement.ts
// GET    /achievements      — list the caller's own achievements
// GET    /achievements/:id  — get one of the caller's own achievements
// POST   /achievements      — create an achievement for the caller
// PUT    /achievements/:id  — update one of the caller's own achievements
// DELETE /achievements/:id  — delete one of the caller's own achievements
//
// Same pattern as education.ts/skill.ts/project.ts/experience.ts: every
// query runs through req.supabase (the caller's own JWT), so Postgres RLS
// — not this code — is what prevents reading/writing another candidate's
// achievements. Deletion is "safe" the same established way: RLS-scoped
// delete, 404 (not a silent no-op or another candidate's row) when the id
// doesn't resolve to one of the caller's own rows.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { AchievementRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const ACHIEVEMENT_COLUMNS =
  "id, title, issuing_body, date_awarded, rank_or_result, verification_url, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function achievementRouter(): Router {
  const router = Router();

  router.get("/achievements", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("achievement")
      .select(ACHIEVEMENT_COLUMNS)
      .order("date_awarded", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "achievement_fetch_failed", message: error.message });
    }
    return res.status(200).json({ achievements: data });
  });

  router.get("/achievements/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("achievement")
      .select(ACHIEVEMENT_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "achievement_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "achievement_not_found" });
    }
    return res.status(200).json({ achievement: data });
  });

  router.post("/achievements", async (req: AuthedRequest, res) => {
    const parsed = AchievementRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("achievement")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(ACHIEVEMENT_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "achievement_create_failed", message: error.message });
    }

    return res.status(201).json({ achievement: data });
  });

  router.put("/achievements/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = AchievementRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("achievement")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(ACHIEVEMENT_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "achievement_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "achievement_not_found" });
    }
    return res.status(200).json({ achievement: data });
  });

  router.delete("/achievements/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("achievement")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "achievement_delete_failed", message: error.message });
    }
    // Safe deletion: RLS guarantees a foreign id (or another candidate's
    // row) never actually deletes anything and is reported as not-found.
    if (!data) {
      return res.status(404).json({ error: "achievement_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
