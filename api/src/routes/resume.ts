// resume.ts
// GET    /resumes                    — list the caller's own resumes
//                                       (active + archived), each with its
//                                       attached skills.
// GET    /resumes/:id                — get one of the caller's own
//                                       resumes, with its attached skills.
// POST   /resumes                    — create a resume for the caller.
//                                       Always created active — is_active
//                                       is PUT-only (see below).
// PUT    /resumes/:id                — update label/target_role_category/
//                                       evidence_source_id/is_active. This
//                                       IS the archive/unarchive
//                                       mechanism (set is_active: false /
//                                       true) — there is no separate
//                                       PATCH /archive endpoint and no
//                                       DELETE /resumes/:id route at all,
//                                       matching docs/gate-r0-resume-
//                                       design.md §3's explicit decision:
//                                       archiving preserves history,
//                                       hard-delete is never exposed via
//                                       the API (mirrors application's
//                                       own no-DELETE-route precedent).
// POST   /resumes/:id/skills         — attach one of the caller's own
//                                       skills to one of the caller's own
//                                       resumes.
// DELETE /resumes/:id/skills/:skillId — detach a skill from a resume
//                                        (does not delete the skill
//                                        itself — skill.ts owns that).
//
// This is the missing piece Gates R1–R6 never built: 0025_resume.sql
// (Gate R1) created the resume/resume_skill schema and every later gate
// (matching, feed, application, bulk-apply) built on TOP of resume_id
// existing on other tables — but nothing ever let a candidate actually
// create, edit, archive, or assign skills to a resume through the API.
// Gate R7 (the frontend) cannot do anything meaningful without this
// existing first.
//
// Same ownership pattern as every other route: every query runs through
// req.supabase (the caller's own JWT), so RLS — not this code — prevents
// reading/writing another candidate's resumes or resume_skill rows. This
// route additionally does explicit app-layer ownership pre-checks before
// the resume_skill insert (same "integrity check on top of RLS, for a
// precise 404 instead of a raw RLS error" precedent as
// POST /applications's opportunity_id check) — 0025_resume.sql's
// resume_skill_insert_own RLS policy checks ownership of BOTH the
// resume_id AND the skill_id being linked, so relying on RLS alone here
// would surface an opaque "row violates row-level security policy"
// error rather than telling the caller specifically which id was wrong.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ResumeCreateRequestSchema, ResumeUpdateRequestSchema, ResumeSkillRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const RESUME_COLUMNS = "id, label, target_role_category, evidence_source_id, is_active, created_at, updated_at";

const UNIQUE_VIOLATION = "23505";

interface ResumeDbRow {
  id: string;
  label: string;
  target_role_category: string | null;
  evidence_source_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ResumeSkillSummary {
  id: string;
  name: string;
  category: string;
}

/**
 * Attaches each resume's skill list via two extra queries (resume_skill,
 * then skill), the same manual-join-with-Map pattern used throughout this
 * codebase (see application.ts's opportunityById/resumeById) rather than
 * a PostgREST nested-embed select — this project has no live Postgres
 * available in the environment these routes were written in to verify a
 * nested embed resolves the way it looks like it should, and a wrong
 * guess there would silently return malformed data rather than erroring,
 * exactly the kind of thing this codebase's "verify against real
 * execution, don't assume" discipline exists to avoid.
 */
async function attachSkills(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  resumes: ResumeDbRow[],
): Promise<Array<ResumeDbRow & { skills: ResumeSkillSummary[] }>> {
  if (resumes.length === 0) return [];

  const resumeIds = resumes.map((r) => r.id);
  const { data: linkRows, error: linkError } = await supabase
    .from("resume_skill")
    .select("resume_id, skill_id")
    .in("resume_id", resumeIds);

  if (linkError) throw linkError;

  const links = (linkRows ?? []) as unknown as Array<{ resume_id: string; skill_id: string }>;
  const skillIds = [...new Set(links.map((l) => l.skill_id))];

  const skillById = new Map<string, ResumeSkillSummary>();
  if (skillIds.length > 0) {
    const { data: skillRows, error: skillError } = await supabase.from("skill").select("id, name, category").in("id", skillIds);
    if (skillError) throw skillError;
    for (const s of (skillRows ?? []) as unknown as ResumeSkillSummary[]) {
      skillById.set(s.id, s);
    }
  }

  const skillIdsByResume = new Map<string, string[]>();
  for (const link of links) {
    const list = skillIdsByResume.get(link.resume_id) ?? [];
    list.push(link.skill_id);
    skillIdsByResume.set(link.resume_id, list);
  }

  return resumes.map((r) => ({
    ...r,
    skills: (skillIdsByResume.get(r.id) ?? []).map((skillId) => skillById.get(skillId)).filter((s): s is ResumeSkillSummary => s !== undefined),
  }));
}

export function resumeRouter(): Router {
  const router = Router();

  router.get("/resumes", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase.from("resume").select(RESUME_COLUMNS).order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "resume_fetch_failed", message: error.message });
    }

    try {
      const enriched = await attachSkills(supabase, (data ?? []) as unknown as ResumeDbRow[]);
      return res.status(200).json({ resumes: enriched });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: "resume_fetch_failed", message });
    }
  });

  router.get("/resumes/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase.from("resume").select(RESUME_COLUMNS).eq("id", idParsed.data).maybeSingle();

    if (error) {
      return res.status(400).json({ error: "resume_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "resume_not_found" });
    }

    try {
      const [enriched] = await attachSkills(supabase, [data as unknown as ResumeDbRow]);
      return res.status(200).json({ resume: enriched });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: "resume_fetch_failed", message });
    }
  });

  router.post("/resumes", async (req: AuthedRequest, res) => {
    const parsed = ResumeCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data: candidate, error: candidateError } = await supabase.from("candidate").select("id").single();
    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }
    const candidateId = (candidate as unknown as { id: string }).id;

    // Gate R4/Gate R7 note: no resume-count limit — 0025_resume.sql's own
    // design explicitly rejected an arbitrary cap (docs/gate-r0-resume-
    // design.md §1, "unbounded... if we later discover a product reason
    // for a limit, we can add one deliberately").
    const { data, error } = await supabase
      .from("resume")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(RESUME_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "resume_create_failed", message: error.message });
    }

    return res.status(201).json({ resume: { ...(data as unknown as ResumeDbRow), skills: [] } });
  });

  router.put("/resumes/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ResumeUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("resume")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(RESUME_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "resume_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way,
    // same convention as skill.ts's own PUT.
    if (!data) {
      return res.status(404).json({ error: "resume_not_found" });
    }

    try {
      const [enriched] = await attachSkills(supabase, [data as unknown as ResumeDbRow]);
      return res.status(200).json({ resume: enriched });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: "resume_fetch_failed", message });
    }
  });

  router.post("/resumes/:id/skills", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ResumeSkillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;

    // Explicit ownership pre-checks (see module header) — precise 404s
    // instead of an opaque RLS violation error from the insert below.
    const { data: ownedResume, error: resumeLookupError } = await supabase
      .from("resume")
      .select("id")
      .eq("id", idParsed.data)
      .maybeSingle();
    if (resumeLookupError) {
      return res.status(400).json({ error: "resume_skill_create_failed", message: resumeLookupError.message });
    }
    if (!ownedResume) {
      return res.status(404).json({ error: "resume_not_found" });
    }

    const { data: ownedSkill, error: skillLookupError } = await supabase
      .from("skill")
      .select("id, name, category")
      .eq("id", parsed.data.skill_id)
      .maybeSingle();
    if (skillLookupError) {
      return res.status(400).json({ error: "resume_skill_create_failed", message: skillLookupError.message });
    }
    if (!ownedSkill) {
      return res.status(404).json({ error: "skill_not_found" });
    }

    const { error: insertError } = await supabase
      .from("resume_skill")
      .insert({ resume_id: idParsed.data, skill_id: parsed.data.skill_id });

    if (insertError) {
      const isDuplicate = insertError.code === UNIQUE_VIOLATION; // uq_resume_skill
      return res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate ? "skill_already_on_resume" : "resume_skill_create_failed",
        message: insertError.message,
      });
    }

    return res.status(201).json({ skill: ownedSkill });
  });

  router.delete("/resumes/:id/skills/:skillId", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    const skillIdParsed = UuidParamSchema.safeParse(req.params.skillId);
    if (!idParsed.success || !skillIdParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("resume_skill")
      .delete()
      .eq("resume_id", idParsed.data)
      .eq("skill_id", skillIdParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "resume_skill_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "resume_skill_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
