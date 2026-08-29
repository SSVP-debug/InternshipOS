// todayView.ts
// Pure aggregation logic for GET /today (the "what should I do today?"
// dashboard — task brief §4.A). Deliberately separated from the route
// handler (todayView.ts has no supabase/Express dependency at all) so the
// prioritization rules can be unit tested directly, same "logic separated
// from I/O for testability" discipline as schemas.ts.
//
// Every element returned here is meant to lead to an actual action (open
// an application, open an opportunity link, log a follow-up) — per the
// brief's explicit warning against "a generic SaaS dashboard filled with
// meaningless cards."
//
// feed_summary (added alongside the P0/P1 automation work): a small,
// read-only surface of the candidate's personalized opportunity feed
// (Phase 2B, lib/opportunityFeed.ts) — new-match count plus the top few
// highest-scoring, non-ineligible, not-yet-promoted matches. This is
// intentionally NOT a duplicate feed UI: no save/dismiss/priority/apply
// actions live here, only enough to prompt "you have new matches, go
// look" and link through to the full /feed page, which remains the only
// place a candidate actually acts on a match. Closes the gap the original
// audit flagged: before this, Today and Feed were two disconnected
// surfaces with no link between them.

import type { OpportunityFeedItem } from "./opportunityFeed.js";

export interface ApplicationRow {
  id: string;
  opportunity_id: string;
  status: string;
  applied_at: string | null;
  deadline_override: string | null; // YYYY-MM-DD
  next_action_date: string | null; // YYYY-MM-DD
  next_action_note: string | null;
  updated_at: string;
}

export interface OpportunityRow {
  id: string;
  title: string;
  company: string;
  application_url: string | null;
  deadline_date: string | null; // YYYY-MM-DD
  inbox_status: "new" | "saved" | "dismissed";
  is_priority: boolean;
}

export interface TodayViewInput {
  applications: ApplicationRow[];
  opportunities: OpportunityRow[];
  // Optional — a caller that hasn't fetched feed data yet (or a test that
  // doesn't care about feed_summary) can omit this entirely; it defaults
  // to an empty feed, which yields new_matches_count: 0, top_matches: [].
  // Expected to already be sorted match_score descending, the same
  // ordering buildOpportunityFeed() itself guarantees — this function does
  // not re-sort.
  feedItems?: OpportunityFeedItem[];
  // Optional — the most recent opportunity_source.last_seen_at the caller
  // can see (RLS-scoped to active rows; see today.ts). A simple, honest
  // "when did the catalog last get fresh data" signal, computed from data
  // that already exists (no new migration) — not a per-candidate value,
  // since ingestion is global/shared across every candidate, not
  // personalized. Null when there is no visible opportunity_source data
  // yet (e.g. ingestion has never run).
  lastIngestedAt?: string | null;
  /** Caller's current date/time. Injected (not `new Date()` internally) so tests are deterministic. */
  now: Date;
}

// Applications in these statuses are done — they don't need daily
// attention and are excluded from action/deadline/follow-up surfaces
// (they still count in pipeline_summary, which is a full picture).
const INACTIVE_STATUSES = new Set(["REJECTED", "WITHDRAWN"]);

// Not-yet-applied statuses — the ones where a looming deadline is
// urgent because the student hasn't acted yet.
const PRE_APPLY_STATUSES = new Set(["SAVED", "APPLYING"]);

const ALL_STATUSES = [
  "SAVED",
  "APPLYING",
  "APPLIED",
  "ASSESSMENT",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
] as const;

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromISODate: string, toISODate: string): number {
  const from = new Date(`${fromISODate}T00:00:00Z`).getTime();
  const to = new Date(`${toISODate}T00:00:00Z`).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

export interface TodayActionItem {
  application_id: string;
  opportunity_id: string;
  title: string;
  company: string;
  reason: "deadline_approaching" | "follow_up_due" | "follow_up_overdue";
  due_date: string;
  days_until_due: number;
}

export interface TodaySavedOpportunity {
  opportunity_id: string;
  title: string;
  company: string;
  application_url: string | null;
  deadline_date: string | null;
  is_priority: boolean;
}

export interface TodayRecentlyApplied {
  application_id: string;
  opportunity_id: string;
  title: string;
  company: string;
  applied_at: string;
}

export interface TodayFeedHighlight {
  opportunity_match_id: string;
  title: string;
  company: string;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
}

export interface TodayFeedSummary {
  // Matches the candidate hasn't triaged yet (inbox_status === "new") and
  // hasn't already turned into an application. Deliberately excludes
  // ineligible matches — an "ineligible" match isn't something that needs
  // the candidate's attention today, it's already resolved.
  new_matches_count: number;
  top_matches: TodayFeedHighlight[];
  // See TodayViewInput.lastIngestedAt — passed through unchanged, not
  // recomputed here. Null means "no visible opportunity_source data yet,"
  // not "unknown" — the frontend can render that as "not yet run" rather
  // than a loading/error state.
  last_ingested_at: string | null;
}

export interface TodayView {
  generated_at: string;
  action_required: TodayActionItem[];
  deadlines_approaching: TodayActionItem[];
  follow_ups_due: TodayActionItem[];
  saved_opportunities: TodaySavedOpportunity[];
  recently_applied: TodayRecentlyApplied[];
  pipeline_summary: Record<string, number>;
  feed_summary: TodayFeedSummary;
  stats: {
    total_applications: number;
    active_applications: number;
    opportunities_needing_triage: number;
    overdue_follow_ups_count: number;
    deadlines_next_7_days_count: number;
  };
}

const TOP_FEED_MATCHES_LIMIT = 3;

function summarizeFeedForToday(feedItems: OpportunityFeedItem[], lastIngestedAt: string | null): TodayFeedSummary {
  // Matches already promoted into an application, or already resolved as
  // ineligible, don't need to surface here — this section exists to
  // prompt "you have something new to look at," not to duplicate the
  // full feed.
  const actionable = feedItems.filter(
    (item) => item.eligibility_status !== "ineligible" && item.promoted_opportunity_id === null,
  );

  const newMatchesCount = actionable.filter((item) => item.inbox_status === "new").length;

  // feedItems is expected to already be sorted match_score descending (see
  // buildOpportunityFeed) — slicing here relies on that ordering rather
  // than re-sorting it, since this is meant to be a cheap, pure summary,
  // not a second ranking implementation to keep in sync with the first.
  const topMatches: TodayFeedHighlight[] = actionable.slice(0, TOP_FEED_MATCHES_LIMIT).map((item) => ({
    opportunity_match_id: item.opportunity_match_id,
    title: item.title,
    company: item.company,
    match_score: item.match_score,
    eligibility_status: item.eligibility_status,
  }));

  return { new_matches_count: newMatchesCount, top_matches: topMatches, last_ingested_at: lastIngestedAt };
}

export function buildTodayView({
  applications,
  opportunities,
  feedItems = [],
  lastIngestedAt = null,
  now,
}: TodayViewInput): TodayView {
  const today = toDateOnly(now);
  const opportunityById = new Map(opportunities.map((o) => [o.id, o]));
  const opportunityIdsWithApplication = new Set(applications.map((a) => a.opportunity_id));

  const actionRequired: TodayActionItem[] = [];
  const deadlinesApproaching: TodayActionItem[] = [];
  const followUpsDue: TodayActionItem[] = [];
  const recentlyApplied: TodayRecentlyApplied[] = [];

  const pipelineSummary: Record<string, number> = {};
  for (const status of ALL_STATUSES) pipelineSummary[status] = 0;

  let activeApplications = 0;
  let overdueFollowUpsCount = 0;
  let deadlinesNext7DaysCount = 0;

  for (const app of applications) {
    pipelineSummary[app.status] = (pipelineSummary[app.status] ?? 0) + 1;

    const opportunity = opportunityById.get(app.opportunity_id);
    const isActive = !INACTIVE_STATUSES.has(app.status);
    if (isActive) activeApplications++;

    const title = opportunity?.title ?? "(opportunity no longer available)";
    const company = opportunity?.company ?? "";

    if (isActive) {
      const deadline = app.deadline_override ?? opportunity?.deadline_date ?? null;
      if (deadline) {
        const daysUntil = daysBetween(today, deadline);
        if (daysUntil <= 14) {
          const item: TodayActionItem = {
            application_id: app.id,
            opportunity_id: app.opportunity_id,
            title,
            company,
            reason: "deadline_approaching",
            due_date: deadline,
            days_until_due: daysUntil,
          };
          deadlinesApproaching.push(item);
          if (daysUntil <= 7) deadlinesNext7DaysCount++;
          // Only surfaces in "needs action today" if the student hasn't
          // applied yet and the deadline is genuinely close (<=3 days) —
          // a looming deadline on an application already APPLIED/beyond
          // isn't something the student needs to act on today.
          if (PRE_APPLY_STATUSES.has(app.status) && daysUntil <= 3) {
            actionRequired.push({ ...item });
          }
        }
      }

      if (app.next_action_date) {
        const daysUntil = daysBetween(today, app.next_action_date);
        if (daysUntil <= 0) {
          const item: TodayActionItem = {
            application_id: app.id,
            opportunity_id: app.opportunity_id,
            title,
            company,
            reason: daysUntil < 0 ? "follow_up_overdue" : "follow_up_due",
            due_date: app.next_action_date,
            days_until_due: daysUntil,
          };
          followUpsDue.push(item);
          actionRequired.push({ ...item });
          if (daysUntil < 0) overdueFollowUpsCount++;
        }
      }
    }

    if (app.applied_at) {
      const appliedDaysAgo = daysBetween(toDateOnly(new Date(app.applied_at)), today);
      if (appliedDaysAgo <= 7 && appliedDaysAgo >= 0) {
        recentlyApplied.push({
          application_id: app.id,
          opportunity_id: app.opportunity_id,
          title,
          company,
          applied_at: app.applied_at,
        });
      }
    }
  }

  const savedOpportunities: TodaySavedOpportunity[] = opportunities
    .filter((o) => o.inbox_status === "saved" && !opportunityIdsWithApplication.has(o.id))
    .sort((a, b) => {
      if (a.is_priority !== b.is_priority) return a.is_priority ? -1 : 1;
      if (a.deadline_date && b.deadline_date) return a.deadline_date < b.deadline_date ? -1 : 1;
      if (a.deadline_date) return -1;
      if (b.deadline_date) return 1;
      return 0;
    })
    .slice(0, 5)
    .map((o) => ({
      opportunity_id: o.id,
      title: o.title,
      company: o.company,
      application_url: o.application_url,
      deadline_date: o.deadline_date,
      is_priority: o.is_priority,
    }));

  const opportunitiesNeedingTriage = opportunities.filter((o) => o.inbox_status === "new").length;

  actionRequired.sort((a, b) => a.days_until_due - b.days_until_due);
  deadlinesApproaching.sort((a, b) => a.days_until_due - b.days_until_due);
  followUpsDue.sort((a, b) => a.days_until_due - b.days_until_due);
  recentlyApplied.sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1));

  return {
    generated_at: now.toISOString(),
    action_required: actionRequired,
    deadlines_approaching: deadlinesApproaching,
    follow_ups_due: followUpsDue,
    saved_opportunities: savedOpportunities,
    recently_applied: recentlyApplied,
    pipeline_summary: pipelineSummary,
    feed_summary: summarizeFeedForToday(feedItems, lastIngestedAt),
    stats: {
      total_applications: applications.length,
      active_applications: activeApplications,
      opportunities_needing_triage: opportunitiesNeedingTriage,
      overdue_follow_ups_count: overdueFollowUpsCount,
      deadlines_next_7_days_count: deadlinesNext7DaysCount,
    },
  };
}
