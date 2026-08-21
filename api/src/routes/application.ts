// application.ts
// GET   /applications             — list the caller's own applications
// GET   /applications/:id         — get one application, including its
//                                    status history and notes
// POST  /applications             — create an application for one of the
//                                    caller's own opportunities (always
//                                    starts as SAVED)
// PUT   /applications/:id         — update next_action/recruiter/deadline
//                                    fields (does NOT touch status)
// PATCH /applications/:id/status  — the only way to move an application
//                                    through its lifecycle; also writes an
//                                    application_status_event row in the
//                                    same request (see 0019's migration
//                                    header for why this is done at the API
//                                    layer, not a DB trigger)
//
// No DELETE route — see 0018_application.sql's header: WITHDRAWN is the
// intended terminal state for "no longer pursuing this," preserving
// history rather than erasing the row. (The DB itself still grants a
// DELETE RLS policy for legitimate accidental-duplicate cleanup, but
// nothing in this API surface exposes it.)
//
// Same ownership pattern as every other route: every query runs through
// req.supabase (the caller's own JWT), so RLS — not this code — prevents
// reading/writing another candidate's applications.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import {
  ApplicationCreateRequestSchema,
  ApplicationUpdateRequestSchema,
  ApplicationStatusTransitionSchema,
  UuidParamSchema,
} from "../lib/schemas.js";

const APPLICATION_COLUMNS =
  "id, opportunity_id, status, applied_at, deadline_override, next_action_date, " +
  "next_action_note, recruiter_name, recruiter_email, created_at, updated_at";

const OPPORTUNITY_SUMMARY_COLUMNS =
  "id, title, company, location, work_mode, application_url, deadline_date";

// Explicit row shapes for the two `*_COLUMNS` selects above. Needed
// because those constants are built with string concatenation (for
// readability, same convention as every other route's `*_COLUMNS`) —
// which widens their inferred type from a string literal to `string`, so
// supabase-js's compile-time column parser can't narrow the result type
// from the select string alone. Every other route in this codebase
// forwards its query result wholesale (`res.json({ x: data })`), so this
// never surfaces there; this file is the first to read individual fields
// back off the result (for the deadline/history/enrichment logic below),
// so it needs the cast this type provides.
interface ApplicationDbRow {
  id: string;
  opportunity_id: string;
  status: string;
  applied_at: string | null;
  deadline_override: string | null;
  next_action_date: string | null;
  next_action_note: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  created_at: string;
  updated_at: string;
}

interface OpportunitySummaryDbRow {
  id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  application_url: string | null;
  deadline_date: string | null;
}

// Postgres check_violation, raised by check_application_status_transition()
// for any transition not in the approved lifecycle table, or by a NOT NULL/
// CHECK constraint on a plain field.
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function applicationRouter(): Router {
  const router = Router();

  router.get("/applications", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;

    let query = supabase
      .from("application")
      .select(APPLICATION_COLUMNS)
      .order("updated_at", { ascending: false });

    if (statusFilter) {
      query = query.eq("status", statusFilter);
    }

    const { data, error } = await query;
    if (error) {
      return res.status(400).json({ error: "application_fetch_failed", message: error.message });
    }
    const applications = (data ?? []) as unknown as ApplicationDbRow[];

    const opportunityIds = [...new Set(applications.map((a) => a.opportunity_id))];
    const opportunityById = new Map<string, OpportunitySummaryDbRow>();
    if (opportunityIds.length > 0) {
      const { data: opportunities, error: oppError } = await supabase
        .from("opportunity")
        .select(OPPORTUNITY_SUMMARY_COLUMNS)
        .in("id", opportunityIds);
      if (oppError) {
        return res.status(400).json({ error: "application_fetch_failed", message: oppError.message });
      }
      for (const opp of (opportunities ?? []) as unknown as OpportunitySummaryDbRow[]) {
        opportunityById.set(opp.id, opp);
      }
    }

    const enriched = applications.map((a) => ({
      ...a,
      opportunity: opportunityById.get(a.opportunity_id) ?? null,
    }));

    return res.status(200).json({ applications: enriched });
  });

  router.get("/applications/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data: applicationRaw, error } = await supabase
      .from("application")
      .select(APPLICATION_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "application_fetch_failed", message: error.message });
    }
    if (!applicationRaw) {
      return res.status(404).json({ error: "application_not_found" });
    }
    const application = applicationRaw as unknown as ApplicationDbRow;

    const [opportunityResult, historyResult, notesResult] = await Promise.all([
      supabase.from("opportunity").select(OPPORTUNITY_SUMMARY_COLUMNS).eq("id", application.opportunity_id).maybeSingle(),
      supabase
        .from("application_status_event")
        .select("id, from_status, to_status, note, created_at")
        .eq("application_id", idParsed.data)
        .order("created_at", { ascending: true }),
      supabase
        .from("application_note")
        .select("id, note_type, content, created_at, updated_at")
        .eq("application_id", idParsed.data)
        .order("created_at", { ascending: false }),
    ]);

    if (opportunityResult.error || historyResult.error || notesResult.error) {
      const firstError = opportunityResult.error ?? historyResult.error ?? notesResult.error;
      return res.status(400).json({ error: "application_fetch_failed", message: firstError!.message });
    }

    return res.status(200).json({
      application: {
        ...application,
        opportunity: opportunityResult.data ?? null,
      },
      status_history: historyResult.data,
      notes: notesResult.data,
    });
  });

  router.post("/applications", async (req: AuthedRequest, res) => {
    const parsed = ApplicationCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // App-layer ownership check on opportunity_id before insert — same
    // "integrity check on top of RLS" precedent as claim's
    // subject_entity_id (see 0018_application.sql's header). Because this
    // query also runs through the caller's own RLS-scoped client, a
    // foreign opportunity_id resolves to "not found" here, never leaking
    // whether it belongs to someone else.
    const { opportunity_id, ...applicationFields } = parsed.data;
    const { data: opportunity, error: opportunityError } = await supabase
      .from("opportunity")
      .select("id")
      .eq("id", opportunity_id)
      .maybeSingle();

    if (opportunityError) {
      return res.status(400).json({ error: "application_create_failed", message: opportunityError.message });
    }
    if (!opportunity) {
      return res.status(404).json({ error: "opportunity_not_found" });
    }

    // status is intentionally omitted — the column default ('SAVED')
    // applies, matching claim's "every new row starts at the initial
    // lifecycle state" convention.
    const { data: insertedRaw, error } = await supabase
      .from("application")
      .insert({ candidate_id: candidateId, opportunity_id, ...applicationFields })
      .select(APPLICATION_COLUMNS)
      .single();

    if (error) {
      const isDuplicate = error.code === UNIQUE_VIOLATION;
      return res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate ? "application_already_exists_for_opportunity" : "application_create_failed",
        message: error.message,
      });
    }
    const data = insertedRaw as unknown as ApplicationDbRow;

    // Seed the status history with the initial SAVED event so every
    // application's history is complete from creation, not just from its
    // first transition.
    await supabase.from("application_status_event").insert({
      application_id: data.id,
      candidate_id: candidateId,
      from_status: null,
      to_status: data.status,
    });

    return res.status(201).json({ application: data });
  });

  router.put("/applications/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ApplicationUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("application")
      .update(parsed.data) // never includes status or opportunity_id
      .eq("id", idParsed.data)
      .select(APPLICATION_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "application_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "application_not_found" });
    }
    return res.status(200).json({ application: data });
  });

  router.patch("/applications/:id/status", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ApplicationStatusTransitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const { data: before, error: beforeError } = await supabase
      .from("application")
      .select("id, status")
      .eq("id", idParsed.data)
      .maybeSingle();

    if (beforeError) {
      return res.status(400).json({ error: "application_status_update_failed", message: beforeError.message });
    }
    if (!before) {
      return res.status(404).json({ error: "application_not_found" });
    }

    const { data: updatedRaw, error } = await supabase
      .from("application")
      .update({ status: parsed.data.status })
      .eq("id", idParsed.data)
      .select(APPLICATION_COLUMNS)
      .maybeSingle();

    if (error) {
      const isIllegalTransition = error.code === CHECK_VIOLATION;
      return res.status(isIllegalTransition ? 409 : 400).json({
        error: isIllegalTransition ? "invalid_status_transition" : "application_status_update_failed",
        message: error.message,
      });
    }
    if (!updatedRaw) {
      return res.status(404).json({ error: "application_not_found" });
    }
    const data = updatedRaw as unknown as ApplicationDbRow;

    // Only record a history event if the status actually changed (a
    // same-status PATCH is a harmless no-op at the DB layer — see the
    // transition trigger — and shouldn't clutter history with duplicate
    // entries).
    if (before.status !== data.status) {
      await supabase.from("application_status_event").insert({
        application_id: data.id,
        candidate_id: candidateId,
        from_status: before.status,
        to_status: data.status,
        note: parsed.data.note,
      });
    }

    return res.status(200).json({ application: data });
  });

  return router;
}
