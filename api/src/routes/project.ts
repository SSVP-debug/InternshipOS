// project.ts
// GET    /projects      — list the caller's own projects
// GET    /projects/:id  — get one of the caller's own projects
// POST   /projects      — create a project for the caller
// PUT    /projects/:id  — update one of the caller's own projects
// DELETE /projects/:id  — delete one of the caller's own projects
//
// Same pattern as education.ts/skill.ts: every query runs through
// req.supabase (the caller's own JWT), so Postgres RLS — not this code —
// is what prevents reading/writing another candidate's projects. Deletion
// is handled the same "safe" way as education/skill: RLS-scoped delete,
// 404 (not a silent no-op or another candidate's row) when the id doesn't
// resolve to one of the caller's own rows. Nothing else references
// public.project yet in Phase 0 (no GitHubRepository, no Claim), so there
// is no cascade/orphan concern to handle beyond that.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ProjectRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const PROJECT_COLUMNS =
  "id, title, description, role, team_size, start_date, end_date, " +
  "is_ongoing, tech_stack, external_url, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function projectRouter(): Router {
  const router = Router();

  router.get("/projects", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("project")
      .select(PROJECT_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "project_fetch_failed", message: error.message });
    }
    return res.status(200).json({ projects: data });
  });

  router.get("/projects/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("project")
      .select(PROJECT_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "project_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "project_not_found" });
    }
    return res.status(200).json({ project: data });
  });

  router.post("/projects", async (req: AuthedRequest, res) => {
    const parsed = ProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("project")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(PROJECT_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "project_create_failed", message: error.message });
    }

    return res.status(201).json({ project: data });
  });

  router.put("/projects/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ProjectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("project")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(PROJECT_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "project_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "project_not_found" });
    }
    return res.status(200).json({ project: data });
  });

  router.delete("/projects/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("project")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "project_delete_failed", message: error.message });
    }
    // Safe deletion: RLS guarantees a foreign id (or another candidate's
    // row) never actually deletes anything and is reported as not-found,
    // exactly like education.ts/skill.ts's delete handling.
    if (!data) {
      return res.status(404).json({ error: "project_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
