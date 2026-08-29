// today.ts
// GET /today — the dashboard from task brief §4.A: "What should I do
// today?" A thin route: fetches the caller's own applications and
// opportunities (through req.supabase, so RLS scopes it to them) and
// hands the raw rows to buildTodayView() (lib/todayView.ts), which is
// pure and unit-tested on its own.
//
// Also fetches the caller's own opportunity_match/opportunity_source rows
// (same tables and column lists opportunity-feed.ts's GET /opportunity-feed
// uses — imported from there, not duplicated) and runs them through the
// same buildOpportunityFeed() pure builder, so feed_summary reflects the
// exact same feed data /opportunity-feed itself would show, never a
// second, drifting implementation of "what does the candidate's feed look
// like." A failure fetching this data is treated the same as a failure
// fetching applications/opportunities — a fatal 400 for the whole
// request — for the same reason: this route already treats any of its
// fetches failing as fatal, and there's no clean way to report "Today
// mostly loaded but the feed section silently didn't" without it reading
// as broken rather than genuinely partial.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { buildTodayView, type ApplicationRow, type OpportunityRow } from "../lib/todayView.js";
import {
  buildOpportunityFeed,
  type OpportunityMatchRow,
  type OpportunitySourceRow,
} from "../lib/opportunityFeed.js";
import { OPPORTUNITY_MATCH_COLUMNS, OPPORTUNITY_SOURCE_COLUMNS } from "./opportunity-feed.js";

export function todayRouter(): Router {
  const router = Router();

  router.get("/today", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase.from("candidate").select("id").single();
    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const [applicationsResult, opportunitiesResult, matchResult] = await Promise.all([
      supabase
        .from("application")
        .select("id, opportunity_id, status, applied_at, deadline_override, next_action_date, next_action_note, updated_at"),
      supabase
        .from("opportunity")
        .select("id, title, company, application_url, deadline_date, inbox_status, is_priority"),
      supabase
        .from("opportunity_match")
        .select(OPPORTUNITY_MATCH_COLUMNS)
        .eq("candidate_id", candidate.id)
        .order("match_score", { ascending: false }),
    ]);

    if (applicationsResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: applicationsResult.error.message });
    }
    if (opportunitiesResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: opportunitiesResult.error.message });
    }
    if (matchResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: matchResult.error.message });
    }

    const matches = (matchResult.data ?? []) as unknown as OpportunityMatchRow[];
    const sourceIds = [...new Set(matches.map((m) => m.opportunity_source_id))];

    let sources: OpportunitySourceRow[] = [];
    if (sourceIds.length > 0) {
      const { data: sourceData, error: sourceError } = await supabase
        .from("opportunity_source")
        .select(OPPORTUNITY_SOURCE_COLUMNS)
        .in("id", sourceIds)
        .eq("status", "active");

      if (sourceError) {
        return res.status(400).json({ error: "today_fetch_failed", message: sourceError.message });
      }
      sources = (sourceData ?? []) as unknown as OpportunitySourceRow[];
    }

    const view = buildTodayView({
      applications: (applicationsResult.data ?? []) as ApplicationRow[],
      opportunities: (opportunitiesResult.data ?? []) as OpportunityRow[],
      feedItems: buildOpportunityFeed(matches, sources),
      now: new Date(),
    });

    return res.status(200).json(view);
  });

  return router;
}
