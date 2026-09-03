// opportunity-feed.ts
// GET   /opportunity-feed                    — the caller's personalized
//                                               feed: their own
//                                               opportunity_match rows
//                                               joined to active
//                                               opportunity_source rows,
//                                               via buildOpportunityFeed()
//                                               (lib/opportunityFeed.ts).
// PATCH /opportunity-matches/:id/inbox       — the ONLY way to change a
//                                               match's inbox_status
//                                               (save/dismiss) or
//                                               is_priority — same shape
//                                               as PATCH
//                                               /opportunities/:id/inbox,
//                                               against opportunity_match
//                                               instead.
// POST  /opportunity-matches/bulk-apply      — Gate R5, see below.
//
// Same ownership pattern as every other route: every query runs through
// req.supabase (the caller's own JWT), so RLS — not this code — prevents
// reading/writing another candidate's data. Never uses the service-role
// client. Phase 2A (runMatchingForCandidate.ts, matchEngine.ts) is the
// only writer of match_score/eligibility_status/match_breakdown; this
// route only reads and re-shapes them, plus the two candidate-triage
// fields it's allowed to update.
//
// GATE R3 — RESUME-SCOPED FEED:
//   - Default request (no ?resume_id): `items` is UNCHANGED — the
//     candidate-level matches (resume_id IS NULL), byte-for-byte the same
//     query and response shape a candidate without any resumes has always
//     gotten. Adding a resume never changes what a candidate sees here
//     unless they explicitly ask for a resume's view via ?resume_id.
//   - `?resume_id=<uuid>`: `items` instead shows THAT resume's scoped
//     matches (ownership-checked — a resume id belonging to another
//     candidate, or that doesn't exist, is a 404, same posture as
//     promoted_opportunity_id's ownership check below). Same
//     buildOpportunityFeed() pure builder either way — the route only
//     changes which rows it queries, not how they're joined/sorted/
//     deduplicated.
//   - `resume_groups` is a NEW, always-present field (empty array for a
//     candidate with no active resumes — i.e. unchanged payload shape for
//     the vast majority of candidates today) — a lightweight per-active-
//     resume summary (id, label, target_role_category, total_matches,
//     eligible_matches) so a frontend can build a resume switcher/"Software
//     Development Resume → 12 matches" view without a second request or
//     re-fetching every resume's full item list. This is intentionally
//     NOT full items-per-resume (that's what ?resume_id is for) — see its
//     own comment below for why counting is capped rather than a true
//     SQL GROUP BY.
//
// GATE R5 — POST /opportunity-matches/bulk-apply: turns 1–20 selected
// opportunity_match rows into applications in a single request. Before
// this gate, "applying" from a match required three separate manual
// steps (see OpportunityInboxUpdateSchema's promoted_opportunity_id
// comment in schemas.ts): POST /opportunities to copy the posting's
// details into a candidate-owned row, PATCH .../inbox to record
// promoted_opportunity_id, then POST /applications. This endpoint does
// all three per selected match, atomically per item (not one giant
// transaction across all items — see the route's own comments on why),
// with per-item failure isolation matching the batch matching
// orchestrator's own convention (runMatchingForActiveCandidates.ts): one
// item failing (or already having been applied to) never aborts the
// rest of the request.
//
// resume_id is carried automatically from each opportunity_match row's
// own resume_id (set back in Gate R2) onto the application it produces —
// this is what makes the endpoint "scoped to one resume" in the sense
// the plan meant: the candidate selects matches from one resume's
// grouped view (Gate R3's resume_groups /?resume_id), and every
// application created here remembers that resume without the caller
// needing to pass resume_id explicitly (contrast with POST
// /applications directly, which Gate R4 made explicit specifically
// because that route has no opportunity_match context to carry it from).
//
// DEDUP (0028_opportunity_source_provenance.sql): if the candidate
// already has an `opportunity` row for the same opportunity_source
// (whether from a previous bulk-apply, a different resume's match for
// the same posting, or a prior manual entry that happens to carry the
// same opportunity_source_id), that existing opportunity is reused
// rather than creating a duplicate — enforced by a DB-level partial
// unique index, not just this route's own check-then-insert logic (see
// that migration's header). If an application already exists for that
// reused opportunity (unique_violation on candidate_id+opportunity_id,
// 0018_application.sql's own long-standing constraint), the item is
// reported as "already_applied", not a hard failure.

import type { SupabaseClient } from "@supabase/supabase-js";
import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { OpportunityInboxUpdateSchema, BulkApplyRequestSchema, UuidParamSchema } from "../lib/schemas.js";
import {
  buildOpportunityFeed,
  type OpportunityMatchRow,
  type OpportunitySourceRow,
} from "../lib/opportunityFeed.js";

export const OPPORTUNITY_MATCH_COLUMNS =
  "id, opportunity_source_id, match_score, eligibility_status, match_breakdown, inbox_status, is_priority, promoted_opportunity_id";

export const OPPORTUNITY_SOURCE_COLUMNS =
  "id, title, company, location, work_mode, employment_type, posted_date, application_url, status";
// Exported (not just module-local) because today.ts also fetches these same
// two tables — for its own feed_summary section (see todayView.ts) — and
// reuses these exact column lists rather than risking drift from a
// hand-copied duplicate.

// MVP cap — no pagination infrastructure yet, just a fixed limit on how
// many of the candidate's own opportunity_match rows are considered for
// one feed request.
const FEED_ITEM_LIMIT = 50;

// Gate R3 — MVP cap on how many resume-scoped match rows are considered
// when computing resume_groups' counts. This is an application-level
// count over a capped row fetch, NOT a true SQL GROUP BY — the
// RLS-scoped req.supabase client goes through PostgREST, which has no
// aggregate-query capability here (that would need a database function,
// which is more machinery than a "lightweight summary" field justifies
// right now). For any candidate whose resume-scoped match count exceeds
// this cap, total_matches/eligible_matches below would undercount rather
// than throw — acceptable for an MVP summary field, but worth a real fix
// (a dedicated aggregate RPC, mirroring upsert_opportunity_match_batch's
// own precedent) if resume counts ever grow large enough for this to
// matter in practice. Not solved speculatively here.
const RESUME_GROUP_COUNT_ROW_CAP = 2000;

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

// Gate R5: opportunity_source.source_type -> opportunity.source. Not a
// 1:1 rename — opportunity_source's enum ('job_board', 'company_site',
// 'manual_seed', 'other') predates and is unrelated to opportunity's own
// ('manual', 'referral', 'company_site', 'job_board', 'career_fair',
// 'other'), so 'manual_seed' has no direct equivalent and falls back to
// 'other' rather than 'manual' — 'manual' specifically means the
// candidate typed it in themselves (0017_opportunity.sql), which this
// auto-created row was not.
const OPPORTUNITY_SOURCE_TYPE_TO_OPPORTUNITY_SOURCE: Record<string, string> = {
  job_board: "job_board",
  company_site: "company_site",
  manual_seed: "other",
  other: "other",
};

// Gate R5: every opportunity_source column bulk-apply needs to populate a
// new candidate-owned `opportunity` row — a superset of both
// OPPORTUNITY_MATCH_COLUMNS's join needs and the feed's own
// OPPORTUNITY_SOURCE_COLUMNS above (which is display-only and omits
// description/skills/deadline_date/source_type — fields the feed never
// shows but opportunity creation needs).
const OPPORTUNITY_SOURCE_COLUMNS_FOR_APPLY =
  "id, source_type, title, company, description, location, work_mode, employment_type, skills, application_url, deadline_date, posted_date";

const UNIQUE_VIOLATION = "23505";

interface BulkApplyResult {
  opportunity_match_id: string;
  status: "applied" | "already_applied" | "failed";
  application_id?: string;
  opportunity_id?: string;
  error?: string;
}

/**
 * One selected match, start to finish: find-or-create the candidate's own
 * `opportunity` row for its underlying opportunity_source (dedup — see
 * 0028_opportunity_source_provenance.sql), record promoted_opportunity_id
 * on the match, create the application (carrying the match's own
 * resume_id automatically), and seed its initial status event — mirroring
 * POST /applications's own seeding step exactly, so an application
 * created via bulk-apply has identical history-completeness to one
 * created the old three-step manual way.
 *
 * Deliberately NOT one big transaction across every selected match (or
 * even across one match's several writes) — this project has no
 * multi-statement-transaction primitive available through the
 * RLS-scoped PostgREST client (see 0026_opportunity_match_resume.sql's
 * upsert_opportunity_match_batch for the one place this codebase reaches
 * for a SQL function instead, when it actually needed atomicity a single
 * INSERT could provide — this operation's several different writes,
 * across three tables, don't fit that same shape). A failure partway
 * through one match (e.g. the application insert fails after the
 * opportunity was already created) leaves that opportunity row behind,
 * unpromoted — not ideal, but recoverable (the next bulk-apply attempt on
 * the same match reuses it via the dedup check, rather than erroring or
 * duplicating), and honestly reported as "failed" rather than
 * papered over.
 */
async function applyOneMatch(
  supabase: Pick<SupabaseClient, "from">,
  candidateId: string,
  opportunityMatchId: string,
): Promise<BulkApplyResult> {
  const { data: match, error: matchError } = await supabase
    .from("opportunity_match")
    .select("id, opportunity_source_id, resume_id, promoted_opportunity_id")
    .eq("id", opportunityMatchId)
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (matchError) {
    return { opportunity_match_id: opportunityMatchId, status: "failed", error: matchError.message };
  }
  if (!match) {
    return { opportunity_match_id: opportunityMatchId, status: "failed", error: "opportunity_match_not_found" };
  }
  const matchRow = match as unknown as {
    id: string;
    opportunity_source_id: string;
    resume_id: string | null;
    promoted_opportunity_id: string | null;
  };

  if (matchRow.promoted_opportunity_id) {
    return { opportunity_match_id: opportunityMatchId, status: "already_applied", opportunity_id: matchRow.promoted_opportunity_id };
  }

  // Dedup check (see migration header) — reuse an existing opportunity
  // for this opportunity_source rather than creating a second one. The
  // partial unique index is the actual guarantee; this SELECT is just
  // avoiding a guaranteed-to-fail INSERT in the common repeat case.
  const { data: existingOpportunity, error: existingLookupError } = await supabase
    .from("opportunity")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("opportunity_source_id", matchRow.opportunity_source_id)
    .maybeSingle();

  if (existingLookupError) {
    return { opportunity_match_id: opportunityMatchId, status: "failed", error: existingLookupError.message };
  }

  let opportunityId: string;

  if (existingOpportunity) {
    opportunityId = (existingOpportunity as unknown as { id: string }).id;
  } else {
    const { data: sourceRow, error: sourceError } = await supabase
      .from("opportunity_source")
      .select(OPPORTUNITY_SOURCE_COLUMNS_FOR_APPLY)
      .eq("id", matchRow.opportunity_source_id)
      .maybeSingle();

    if (sourceError) {
      return { opportunity_match_id: opportunityMatchId, status: "failed", error: sourceError.message };
    }
    if (!sourceRow) {
      // The posting was removed from the catalog between matching and
      // apply — nothing to copy. Honest failure, not a fabricated
      // opportunity built from whatever fields happen to be on the match
      // row itself.
      return { opportunity_match_id: opportunityMatchId, status: "failed", error: "opportunity_source_not_found" };
    }
    const source = sourceRow as unknown as {
      id: string;
      source_type: string;
      title: string;
      company: string;
      description: string | null;
      location: string | null;
      work_mode: string | null;
      employment_type: string;
      skills: string[];
      application_url: string | null;
      deadline_date: string | null;
      posted_date: string | null;
    };

    const { data: createdOpportunity, error: createError } = await supabase
      .from("opportunity")
      .insert({
        candidate_id: candidateId,
        opportunity_source_id: source.id,
        title: source.title,
        company: source.company,
        description: source.description,
        location: source.location,
        work_mode: source.work_mode,
        employment_type: source.employment_type,
        skills: source.skills,
        application_url: source.application_url,
        source: OPPORTUNITY_SOURCE_TYPE_TO_OPPORTUNITY_SOURCE[source.source_type] ?? "other",
        deadline_date: source.deadline_date,
        posted_date: source.posted_date,
        inbox_status: "saved", // the candidate is actively applying to it — never leave it sitting as "new"
      })
      .select("id")
      .single();

    if (createError) {
      // Belt-and-braces: if a concurrent request already created this
      // exact (candidate, opportunity_source) opportunity between our
      // SELECT above and this INSERT, the partial unique index catches
      // it here — re-read and reuse rather than surfacing a raw
      // constraint violation to the caller.
      if (createError.code === UNIQUE_VIOLATION) {
        const { data: raceWinner, error: raceLookupError } = await supabase
          .from("opportunity")
          .select("id")
          .eq("candidate_id", candidateId)
          .eq("opportunity_source_id", matchRow.opportunity_source_id)
          .maybeSingle();
        if (raceLookupError || !raceWinner) {
          return { opportunity_match_id: opportunityMatchId, status: "failed", error: createError.message };
        }
        opportunityId = (raceWinner as unknown as { id: string }).id;
      } else {
        return { opportunity_match_id: opportunityMatchId, status: "failed", error: createError.message };
      }
    } else {
      opportunityId = (createdOpportunity as unknown as { id: string }).id;
    }
  }

  // Record the promotion on the match — same field, same meaning, as the
  // pre-Gate-R5 manual PATCH .../inbox flow (see schemas.ts's
  // promoted_opportunity_id comment). Not fatal if this write fails: the
  // application itself (below) is the record that actually matters, and
  // is still created even if this housekeeping update doesn't stick —
  // reported as part of the result either way, not silently swallowed.
  const { error: promoteError } = await supabase
    .from("opportunity_match")
    .update({ promoted_opportunity_id: opportunityId })
    .eq("id", opportunityMatchId)
    .eq("candidate_id", candidateId);

  const { data: createdApplication, error: applicationError } = await supabase
    .from("application")
    .insert({ candidate_id: candidateId, opportunity_id: opportunityId, resume_id: matchRow.resume_id })
    .select("id, status")
    .single();

  if (applicationError) {
    if (applicationError.code === UNIQUE_VIOLATION) {
      return { opportunity_match_id: opportunityMatchId, status: "already_applied", opportunity_id: opportunityId };
    }
    return {
      opportunity_match_id: opportunityMatchId,
      status: "failed",
      opportunity_id: opportunityId,
      error: promoteError ? `${applicationError.message} (also failed to record promotion: ${promoteError.message})` : applicationError.message,
    };
  }

  const application = createdApplication as unknown as { id: string; status: string };

  // Seed the status history exactly like POST /applications does — an
  // application created via bulk-apply must not have thinner history
  // than one created the manual way.
  await supabase.from("application_status_event").insert({
    application_id: application.id,
    candidate_id: candidateId,
    from_status: null,
    to_status: application.status,
  });

  return {
    opportunity_match_id: opportunityMatchId,
    status: "applied",
    application_id: application.id,
    opportunity_id: opportunityId,
  };
}

export function opportunityFeedRouter(): Router {
  const router = Router();

  router.get("/opportunity-feed", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // Gate R3: ?resume_id is optional. Absent -> resume_id IS NULL rows
    // (the pre-existing candidate-level feed, unchanged). Present -> must
    // be a real UUID that resolves to one of THIS candidate's own resume
    // rows (RLS-scoped select — a row belonging to someone else, or that
    // doesn't exist, comes back as no row either way, which is exactly
    // what we want: it's a 404 either way, not a distinction worth
    // leaking).
    let resumeId: string | null = null;
    if (req.query?.resume_id !== undefined) {
      const resumeIdParsed = UuidParamSchema.safeParse(req.query.resume_id);
      if (!resumeIdParsed.success) {
        return res.status(400).json({ error: "invalid_resume_id" });
      }
      const { data: ownedResume, error: resumeLookupError } = await supabase
        .from("resume")
        .select("id")
        .eq("id", resumeIdParsed.data)
        .maybeSingle();

      if (resumeLookupError) {
        return res.status(400).json({ error: "resume_lookup_failed", message: resumeLookupError.message });
      }
      if (!ownedResume) {
        return res.status(404).json({ error: "resume_not_found" });
      }
      resumeId = resumeIdParsed.data;
    }

    let itemsQuery = supabase
      .from("opportunity_match")
      .select(OPPORTUNITY_MATCH_COLUMNS)
      .eq("candidate_id", candidateId)
      .order("match_score", { ascending: false })
      .limit(FEED_ITEM_LIMIT);
    itemsQuery = resumeId === null ? itemsQuery.is("resume_id", null) : itemsQuery.eq("resume_id", resumeId);

    const { data: matchData, error: matchError } = await itemsQuery;

    if (matchError) {
      return res.status(400).json({ error: "opportunity_feed_fetch_failed", message: matchError.message });
    }

    const matches = (matchData ?? []) as unknown as OpportunityMatchRow[];

    // Gate R3: resume_groups needs its own row set — every resume-scoped
    // match, regardless of which resumeId (if any) `items` above is
    // currently showing — so the frontend can render a full resume
    // switcher no matter which view the candidate is currently in. Kept
    // as a second, separate query rather than trying to fold into the
    // `matches` query above, since `items`' LIMIT/ordering is a
    // presentation concern for ONE view and resume_groups' cap is a
    // completely separate, deliberately generous one (see
    // RESUME_GROUP_COUNT_ROW_CAP above) — conflating the two would mean
    // either starving `items` to make room for group-counting rows, or
    // capping group counts down to FEED_ITEM_LIMIT, both wrong.
    const { data: resumeRows, error: resumeListError } = await supabase
      .from("resume")
      .select("id, label, target_role_category")
      .eq("is_active", true);

    if (resumeListError) {
      return res.status(400).json({ error: "opportunity_feed_fetch_failed", message: resumeListError.message });
    }

    const activeResumes = (resumeRows ?? []) as unknown as Array<{
      id: string;
      label: string;
      target_role_category: string | null;
    }>;

    let resumeScopedMatches: Array<{
      resume_id: string;
      opportunity_source_id: string;
      eligibility_status: string | null;
    }> = [];

    if (activeResumes.length > 0) {
      const { data: resumeMatchData, error: resumeMatchError } = await supabase
        .from("opportunity_match")
        .select("resume_id, opportunity_source_id, eligibility_status")
        .eq("candidate_id", candidateId)
        .not("resume_id", "is", null)
        .limit(RESUME_GROUP_COUNT_ROW_CAP);

      if (resumeMatchError) {
        return res.status(400).json({ error: "opportunity_feed_fetch_failed", message: resumeMatchError.message });
      }
      resumeScopedMatches = (resumeMatchData ?? []) as unknown as typeof resumeScopedMatches;
    }

    // A resume-scoped match only "counts" toward the summary if its
    // opportunity is still active — same rule buildOpportunityFeed()
    // already applies to `items`, kept consistent here rather than
    // counting stale/closed postings a candidate would never actually see.
    const sourceIds = [
      ...new Set([...matches.map((m) => m.opportunity_source_id), ...resumeScopedMatches.map((m) => m.opportunity_source_id)]),
    ];

    let sources: OpportunitySourceRow[] = [];
    if (sourceIds.length > 0) {
      const { data: sourceData, error: sourceError } = await supabase
        .from("opportunity_source")
        .select(OPPORTUNITY_SOURCE_COLUMNS)
        .in("id", sourceIds)
        .eq("status", "active");

      if (sourceError) {
        return res.status(400).json({ error: "opportunity_feed_fetch_failed", message: sourceError.message });
      }
      sources = (sourceData ?? []) as unknown as OpportunitySourceRow[];
    }

    const activeSourceIds = new Set(sources.map((s) => s.id));

    const resumeGroups = activeResumes.map((resume) => {
      const rowsForThisResume = resumeScopedMatches.filter(
        (m) => m.resume_id === resume.id && activeSourceIds.has(m.opportunity_source_id)
      );
      return {
        resume_id: resume.id,
        label: resume.label,
        target_role_category: resume.target_role_category,
        total_matches: rowsForThisResume.length,
        eligible_matches: rowsForThisResume.filter((m) => m.eligibility_status === "eligible").length,
      };
    });

    const items = buildOpportunityFeed(matches, sources);

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      items,
      resume_groups: resumeGroups,
    });
  });

  router.patch("/opportunity-matches/:id/inbox", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = OpportunityInboxUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // promoted_opportunity_id references public.opportunity(id) — a
    // Postgres FK constraint only checks that the row EXISTS, not that
    // this candidate owns it (FK checks run outside RLS). Since
    // `opportunity` is itself candidate-owned (0017_opportunity.sql), a
    // candidate must not be able to point their own opportunity_match row
    // at someone else's opportunity id. req.supabase is RLS-scoped, so a
    // SELECT for an id that isn't this candidate's own opportunity simply
    // returns no row (RLS's normal silent-filter behavior) — that's used
    // here as the ownership check, same "confirm it's actually theirs
    // before writing" posture used for id+candidate_id below.
    if (parsed.data.promoted_opportunity_id) {
      const { data: ownedOpportunity, error: opportunityError } = await supabase
        .from("opportunity")
        .select("id")
        .eq("id", parsed.data.promoted_opportunity_id)
        .maybeSingle();

      if (opportunityError) {
        return res
          .status(400)
          .json({ error: "promoted_opportunity_lookup_failed", message: opportunityError.message });
      }
      if (!ownedOpportunity) {
        return res.status(400).json({ error: "invalid_promoted_opportunity_id" });
      }
    }

    // Scoped to BOTH id and candidate_id — RLS already restricts this
    // candidate's client to their own rows, but the explicit candidate_id
    // filter is kept here anyway (defense in depth, and it's what makes a
    // "not found" response mean "not found OR not yours" without relying
    // solely on RLS's silent-filter behavior), matching the task brief's
    // explicit requirement and the same belt-and-braces posture used
    // elsewhere in this codebase.
    const { data, error } = await supabase
      .from("opportunity_match")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .eq("candidate_id", candidateId)
      .select(OPPORTUNITY_MATCH_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "opportunity_match_inbox_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "opportunity_match_not_found" });
    }
    return res.status(200).json({ opportunity_match: data });
  });

  router.post("/opportunity-matches/bulk-apply", async (req: AuthedRequest, res) => {
    const parsed = BulkApplyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    // Sequential, not Promise.all — each item does several dependent
    // writes (opportunity, then match update, then application, then
    // status event), and running 20 of those chains concurrently against
    // the same RLS-scoped connection buys nothing (PostgREST has no
    // client-side connection pooling to parallelize here) while making
    // partial-failure reporting harder to reason about. Same "isolate
    // one item's failure, keep going" posture as the batch matching
    // orchestrator (runMatchingForActiveCandidates.ts), just sequential
    // instead of already-independent-by-construction.
    const results: BulkApplyResult[] = [];
    for (const opportunityMatchId of parsed.data.opportunity_match_ids) {
      results.push(await applyOneMatch(supabase, candidateId, opportunityMatchId));
    }

    const summary = {
      applied: results.filter((r) => r.status === "applied").length,
      already_applied: results.filter((r) => r.status === "already_applied").length,
      failed: results.filter((r) => r.status === "failed").length,
    };

    return res.status(200).json({ results, summary });
  });

  return router;
}
