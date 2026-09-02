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
//
// Also fetches a single MAX(last_seen_at)-equivalent row from
// opportunity_source (RLS-scoped to active rows, same as the feed fetch
// above) to answer "when did the catalog last get fresh data" — a small,
// honest freshness signal for the daily-automation work
// (.github/workflows/daily-pipeline.yml), using a column that already
// exists rather than a new migration/run-log table. This is global, not
// per-candidate (ingestion is shared across every candidate), and is
// deliberately NOT gated behind "does this candidate have any matches" —
// even a brand-new candidate with zero matches should be able to see
// "the catalog itself is being kept fresh," which is reassuring on its
// own regardless of whether it's found them a match yet.
//
// GATE R3 — TWO CHANGES:
//   1. CORRECTNESS FIX: the main opportunity_match query below now filters
//      `.is("resume_id", null)`. Before this fix, Gate R2 had silently
//      broken feed_summary for any candidate with resumes — the query was
//      still just `.eq("candidate_id", ...)`, which after Gate R2 returns
//      MULTIPLE rows per opportunity (one candidate-level + one per
//      resume) instead of the one row it always used to. Left unfixed,
//      new_matches_count and top_matches would have been inflated by
//      duplicate opportunities for exactly the candidates this feature is
//      being built for — caught while wiring up resume_highlights below,
//      not by any test (none of the existing tests had a candidate with
//      resumes), which is itself worth noting: opportunity-feed.ts got
//      this right from Gate R3's start (its default view was designed
//      around it from the beginning), today.ts did not, because it was
//      written before that design decision existed.
//   2. NEW: feed_summary.resume_highlights (see todayView.ts) — one more
//      query for the candidate's active resumes, one more for their
//      resume-scoped matches, grouped in-memory by resume_id and each
//      group run through the same buildOpportunityFeed()/summarizeItems
//      pipeline the flat feed already uses.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { buildTodayView, type ApplicationRow, type OpportunityRow, type TodayFeedResumeGroup } from "../lib/todayView.js";
import {
  buildOpportunityFeed,
  type OpportunityMatchRow,
  type OpportunitySourceRow,
} from "../lib/opportunityFeed.js";
import { OPPORTUNITY_MATCH_COLUMNS, OPPORTUNITY_SOURCE_COLUMNS } from "./opportunity-feed.js";

// Gate R3: same OPPORTUNITY_MATCH_COLUMNS as the candidate-level query
// below, plus resume_id — needed here (and only here) so the
// resume-scoped rows can be grouped by which resume they belong to
// before being handed to buildOpportunityFeed() per group. The
// candidate-level query intentionally does NOT select resume_id — it
// doesn't need it (every row it returns has resume_id IS NULL by
// construction of the filter itself).
const RESUME_SCOPED_MATCH_COLUMNS = `${OPPORTUNITY_MATCH_COLUMNS}, resume_id`;

export function todayRouter(): Router {
  const router = Router();

  router.get("/today", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase.from("candidate").select("id").single();
    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const [applicationsResult, opportunitiesResult, matchResult, resumeMatchResult, resumeListResult, freshnessResult] =
      await Promise.all([
        supabase
          .from("application")
          .select(
            "id, opportunity_id, status, applied_at, deadline_override, next_action_date, next_action_note, updated_at",
          ),
        supabase
          .from("opportunity")
          .select("id, title, company, application_url, deadline_date, inbox_status, is_priority"),
        supabase
          .from("opportunity_match")
          .select(OPPORTUNITY_MATCH_COLUMNS)
          .eq("candidate_id", candidate.id)
          .is("resume_id", null) // Gate R3 correctness fix — see module header comment.
          .order("match_score", { ascending: false }),
        supabase
          .from("opportunity_match")
          .select(RESUME_SCOPED_MATCH_COLUMNS)
          .eq("candidate_id", candidate.id)
          .not("resume_id", "is", null)
          .order("match_score", { ascending: false }),
        supabase.from("resume").select("id, label, target_role_category").eq("is_active", true),
        supabase
          .from("opportunity_source")
          .select("last_seen_at")
          .eq("status", "active")
          .order("last_seen_at", { ascending: false })
          .limit(1),
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
    if (resumeMatchResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: resumeMatchResult.error.message });
    }
    if (resumeListResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: resumeListResult.error.message });
    }
    if (freshnessResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: freshnessResult.error.message });
    }

    const matches = (matchResult.data ?? []) as unknown as OpportunityMatchRow[];
    const resumeScopedMatches = (resumeMatchResult.data ?? []) as unknown as Array<
      OpportunityMatchRow & { resume_id: string }
    >;
    const activeResumes = (resumeListResult.data ?? []) as unknown as Array<{
      id: string;
      label: string;
      target_role_category: string | null;
    }>;

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
        return res.status(400).json({ error: "today_fetch_failed", message: sourceError.message });
      }
      sources = (sourceData ?? []) as unknown as OpportunitySourceRow[];
    }

    // Gate R3: group the resume-scoped rows by resume_id, then run each
    // group through the SAME buildOpportunityFeed() pure builder the flat
    // feed above uses (against the same `sources`) — never a
    // differently-filtered/joined notion of "what does this resume's feed
    // look like." Every active resume gets an entry even with zero
    // matches (see todayView.ts's own comment on why that's deliberate).
    const resumeFeedGroups: TodayFeedResumeGroup[] = activeResumes.map((resume) => {
      const rowsForThisResume = resumeScopedMatches.filter((m) => m.resume_id === resume.id);
      return {
        resumeId: resume.id,
        label: resume.label,
        targetRoleCategory: resume.target_role_category,
        items: buildOpportunityFeed(rowsForThisResume, sources),
      };
    });

    const freshnessRows = (freshnessResult.data ?? []) as unknown as Array<{ last_seen_at: string | null }>;
    const lastIngestedAt = freshnessRows[0]?.last_seen_at ?? null;

    const view = buildTodayView({
      applications: (applicationsResult.data ?? []) as ApplicationRow[],
      opportunities: (opportunitiesResult.data ?? []) as OpportunityRow[],
      feedItems: buildOpportunityFeed(matches, sources),
      resumeFeedGroups,
      lastIngestedAt,
      now: new Date(),
    });

    return res.status(200).json(view);
  });

  return router;
}
