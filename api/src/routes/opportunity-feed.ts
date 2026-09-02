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
//
// Same ownership pattern as every other route: every query runs through
// req.supabase (the caller's own JWT), so RLS — not this code — prevents
// reading/writing another candidate's data. Never uses the service-role
// client. Phase 2A (runMatchingForCandidate.ts, matchEngine.ts) is the
// only writer of match_score/eligibility_status/match_breakdown; this
// route only reads and re-shapes them, plus the two candidate-triage
// fields it's allowed to update.
//
// GATE R3 — RESUME-SCOPED FEED (your explicit decision, confirmed before
// this gate started):
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

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { OpportunityInboxUpdateSchema, UuidParamSchema } from "../lib/schemas.js";
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

  return router;
}
