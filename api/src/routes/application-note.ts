// application-note.ts
// GET    /applications/:applicationId/notes      — list notes on one of the
//                                                    caller's own applications
// POST   /applications/:applicationId/notes      — add a note to one of the
//                                                    caller's own applications
// PUT    /application-notes/:id                  — edit one of the caller's
//                                                    own notes
// DELETE /application-notes/:id                  — delete one of the
//                                                    caller's own notes
//
// Notes are lightweight and editable (unlike application_status_event,
// which is permanent) — see 0020_application_note.sql's header.
//
// Same ownership pattern as every other route: every query runs through
// req.supabase (the caller's own JWT), so RLS — not this code — prevents
// reading/writing another candidate's notes. The one extra check this file
// does beyond RLS is confirming, at creation time, that :applicationId
// actually belongs to the caller before attaching a note to it — the same
// "app-layer integrity check on top of RLS" precedent as claim's
// subject_entity_id and application's opportunity_id (see 0020's header).

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ApplicationNoteRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const NOTE_COLUMNS = "id, application_id, note_type, content, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function applicationNoteRouter(): Router {
  const router = Router();

  router.get("/applications/:applicationId/notes", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.applicationId);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("application_note")
      .select(NOTE_COLUMNS)
      .eq("application_id", idParsed.data)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "application_note_fetch_failed", message: error.message });
    }
    return res.status(200).json({ notes: data });
  });

  router.post("/applications/:applicationId/notes", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.applicationId);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ApplicationNoteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // Ownership check: does this application belong to the caller? Runs
    // through the RLS-scoped client, so a foreign applicationId resolves
    // to "not found" rather than leaking existence.
    const { data: application, error: applicationError } = await supabase
      .from("application")
      .select("id")
      .eq("id", idParsed.data)
      .maybeSingle();

    if (applicationError) {
      return res.status(400).json({ error: "application_note_create_failed", message: applicationError.message });
    }
    if (!application) {
      return res.status(404).json({ error: "application_not_found" });
    }

    const { data, error } = await supabase
      .from("application_note")
      .insert({ application_id: idParsed.data, candidate_id: candidateId, ...parsed.data })
      .select(NOTE_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "application_note_create_failed", message: error.message });
    }
    return res.status(201).json({ note: data });
  });

  router.put("/application-notes/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ApplicationNoteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("application_note")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(NOTE_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "application_note_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "application_note_not_found" });
    }
    return res.status(200).json({ note: data });
  });

  router.delete("/application-notes/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("application_note")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "application_note_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "application_note_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
