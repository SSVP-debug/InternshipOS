// education.ts
// GET    /education      — list the caller's own education records
// GET    /education/:id  — get one of the caller's own education records
// POST   /education      — create an education record for the caller
// PUT    /education/:id  — full update of one of the caller's own records
// DELETE /education/:id  — delete one of the caller's own records
//
// Same pattern as profile.ts: every query runs through req.supabase (the
// caller's own JWT), so Postgres RLS — not this code — is what prevents
// reading/writing another candidate's education records. Unlike
// personal_info (1:1), education is 1:many, so requests are id-scoped; the
// id alone is never sufficient to access a row that isn't the caller's,
// because RLS filters by candidate ownership regardless of which id is
// requested.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { EducationRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const EDUCATION_COLUMNS =
  "id, institution_name, institution_country, degree_type, major, minor, " +
  "gpa_value, gpa_scale, start_date, expected_graduation_date, " +
  "actual_graduation_date, enrollment_status, is_primary, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function educationRouter(): Router {
  const router = Router();

  router.get("/education", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("education")
      .select(EDUCATION_COLUMNS)
      .order("start_date", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "education_fetch_failed", message: error.message });
    }
    return res.status(200).json({ education: data });
  });

  router.get("/education/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("education")
      .select(EDUCATION_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "education_fetch_failed", message: error.message });
    }
    // RLS guarantees this is either the caller's own row or no row at all —
    // a foreign id resolves to not-found, never another candidate's data.
    if (!data) {
      return res.status(404).json({ error: "education_not_found" });
    }
    return res.status(200).json({ education: data });
  });

  router.post("/education", async (req: AuthedRequest, res) => {
    const parsed = EducationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("education")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(EDUCATION_COLUMNS)
      .single();

    if (error) {
      const isPrimaryConflict = error.message.includes("uq_education_primary_per_candidate");
      return res.status(isPrimaryConflict ? 409 : 400).json({
        error: isPrimaryConflict ? "primary_education_already_set" : "education_create_failed",
        message: error.message,
      });
    }

    return res.status(201).json({ education: data });
  });

  router.put("/education/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = EducationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("education")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(EDUCATION_COLUMNS)
      .maybeSingle();

    if (error) {
      const isPrimaryConflict = error.message.includes("uq_education_primary_per_candidate");
      return res.status(isPrimaryConflict ? 409 : 400).json({
        error: isPrimaryConflict ? "primary_education_already_set" : "education_update_failed",
        message: error.message,
      });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "education_not_found" });
    }
    return res.status(200).json({ education: data });
  });

  router.delete("/education/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("education")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "education_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "education_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
