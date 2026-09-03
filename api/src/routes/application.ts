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
//
// GATE R4 — resume_id: tracking only (your explicit Gate R0 decision) —
// which resume was used for an application, set explicitly by the
// candidate at creation (POST) or correction (PUT), never inferred from
// an opportunity_match row (see 0027_application_resume.sql's own
// comment on why inference would be ambiguous). Same ownership-check
// posture as opportunity_id: an RLS-scoped SELECT for a resume_id that
// isn't the caller's own simply returns no row.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import {
  ApplicationCreateRequestSchema,
  ApplicationUpdateRequestSchema,
  ApplicationStatusTransitionSchema,
  UuidParamSchema,
} from "../lib/schemas.js";

const APPLICATION_COLUMNS =
  "id, opportunity_id, resume_id, status, applied_at, deadline_override, next_action_date, " +
  "next_action_note, recruiter_name, recruiter_email, created_at, updated_at";

const OPPORTUNITY_SUMMARY_COLUMNS =
  "id, title, company, location, work_mode, application_url, deadline_date";

// Gate R4 — deliberately just id/label/target_role_category, not
// evidence_source_id: the LIST endpoint (GET /applications) enriches
// every row with this for a picker/badge UI ("Software Development"),
// but doesn't need the file itself. The single-application view (GET
// /applications/:id) additionally fetches evidence_source_id separately
// (see below) — that's the one place "retrieve the actual resume file
// used for this application" (the plan's original ask) actually applies,
// and it's not worth carrying an unused evidence_source_id through every
// row of a list response.
const RESUME_SUMMARY_COLUMNS = "id, label, target_role_category";

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
  resume_id: string | null;
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

interface ResumeSummaryDbRow {
  id: string;
  label: string;
  target_role_category: string | null;
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

    // Gate R4: batch-fetch resume summaries the same way opportunities are
    // batched above — one IN query for every distinct resume_id present,
    // not one query per application.
    const resumeIds = [...new Set(applications.map((a) => a.resume_id).filter((id): id is string => id !== null))];
    const resumeById = new Map<string, ResumeSummaryDbRow>();
    if (resumeIds.length > 0) {
      const { data: resumes, error: resumeError } = await supabase
        .from("resume")
        .select(RESUME_SUMMARY_COLUMNS)
        .in("id", resumeIds);
      if (resumeError) {
        return res.status(400).json({ error: "application_fetch_failed", message: resumeError.message });
      }
      for (const resume of (resumes ?? []) as unknown as ResumeSummaryDbRow[]) {
        resumeById.set(resume.id, resume);
      }
    }

    const enriched = applications.map((a) => ({
      ...a,
      opportunity: opportunityById.get(a.opportunity_id) ?? null,
      // Gate R4: null both when no resume was recorded AND when a
      // recorded resume_id no longer resolves (e.g. it was deleted after
      // ON DELETE SET NULL already cleared a.resume_id itself — this
      // branch only matters for the brief window, if any, between that
      // happening and this query running; there is no way for
      // resume_id to be non-null here yet resolve to nothing under
      // normal operation) — either way, "we don't know which resume" is
      // the honest answer, not an error.
      resume: a.resume_id ? (resumeById.get(a.resume_id) ?? null) : null,
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

    const [opportunityResult, historyResult, notesResult, resumeResult] = await Promise.all([
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
      // Gate R4: this is the one place evidence_source_id is fetched —
      // "retrieve the actual resume file used for this application," the
      // plan's original ask for this gate. Skipped entirely (not even
      // queried) when application.resume_id is null, same
      // don't-query-what-you-don't-need pattern the opportunity/
      // sourceIds fetches elsewhere in this codebase already follow.
      application.resume_id
        ? supabase
            .from("resume")
            .select("id, label, target_role_category, evidence_source_id")
            .eq("id", application.resume_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (opportunityResult.error || historyResult.error || notesResult.error || resumeResult.error) {
      const firstError = opportunityResult.error ?? historyResult.error ?? notesResult.error ?? resumeResult.error;
      return res.status(400).json({ error: "application_fetch_failed", message: firstError!.message });
    }

    return res.status(200).json({
      application: {
        ...application,
        opportunity: opportunityResult.data ?? null,
        resume: resumeResult.data ?? null,
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
    const { opportunity_id, resume_id, ...applicationFields } = parsed.data;
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

    // Gate R4: same ownership-check posture as opportunity_id immediately
    // above — an RLS-scoped SELECT for a resume_id belonging to another
    // candidate (or that doesn't exist) simply returns no row, which is
    // used here as the check itself.
    if (resume_id) {
      const { data: ownedResume, error: resumeError } = await supabase
        .from("resume")
        .select("id")
        .eq("id", resume_id)
        .maybeSingle();

      if (resumeError) {
        return res.status(400).json({ error: "application_create_failed", message: resumeError.message });
      }
      if (!ownedResume) {
        return res.status(404).json({ error: "resume_not_found" });
      }
    }

    // status is intentionally omitted — the column default ('SAVED')
    // applies, matching claim's "every new row starts at the initial
    // lifecycle state" convention.
    const { data: insertedRaw, error } = await supabase
      .from("application")
      .insert({ candidate_id: candidateId, opportunity_id, resume_id: resume_id ?? null, ...applicationFields })
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

    // Gate R4: same ownership-check posture as POST /applications — only
    // when the PUT is actually SETTING a resume_id (a truthy string).
    // `undefined` (field omitted — leave resume_id untouched) and
    // explicit `null` (clear it) both need no ownership check: there's
    // nothing to verify ownership of when the candidate isn't pointing at
    // a specific resume row.
    if (parsed.data.resume_id) {
      const { data: ownedResume, error: resumeError } = await supabase
        .from("resume")
        .select("id")
        .eq("id", parsed.data.resume_id)
        .maybeSingle();

      if (resumeError) {
        return res.status(400).json({ error: "application_update_failed", message: resumeError.message });
      }
      if (!ownedResume) {
        return res.status(404).json({ error: "resume_not_found" });
      }
    }

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
