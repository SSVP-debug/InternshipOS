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

    const { data: matchData, error: matchError } = await supabase
      .from("opportunity_match")
      .select(OPPORTUNITY_MATCH_COLUMNS)
      .eq("candidate_id", candidateId)
      .order("match_score", { ascending: false })
      .limit(FEED_ITEM_LIMIT);

    if (matchError) {
      return res.status(400).json({ error: "opportunity_feed_fetch_failed", message: matchError.message });
    }

    const matches = (matchData ?? []) as unknown as OpportunityMatchRow[];
    const sourceIds = [...new Set(matches.map((m) => m.opportunity_source_id))];

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

    const items = buildOpportunityFeed(matches, sources);

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      items,
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
