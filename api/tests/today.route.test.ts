import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { todayRouter } from "../src/routes/today.js";

// Same harness conventions as opportunity-feed.route.test.ts — kept
// identical rather than shared, so each route test file stays
// self-contained and readable on its own.

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get", path: string) {
  const router = todayRouter() as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(
  handlers: ((req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown)[],
  req: AuthedRequest,
  res: Response,
) {
  let index = 0;
  const next = async (err?: unknown) => {
    if (err) throw err;
    index++;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await handlers[0](req, res, next);
}

function makeRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  res.send = vi.fn(() => res) as unknown as Response["send"];
  return res;
}

function queryResult(data: unknown, error: { message: string } | null = null) {
  const result = { data, error };
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.in = self;
  builder.order = self;
  builder.limit = self;
  builder.single = async () => result;
  // Gate R3: .is("resume_id", null) / .not("resume_id", "is", null) —
  // same no-op-chain-but-still-resolve-to-`result` treatment as the
  // other filter methods above.
  builder.is = self;
  builder.not = self;
  builder.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

const CANDIDATE_ID = "cand-1";
const SOURCE_ID = "source-1";

const ACTIVE_SOURCE_ROW = {
  id: SOURCE_ID,
  title: "Backend Engineering Intern",
  company: "Nimbus Labs",
  location: "Remote",
  work_mode: "remote",
  employment_type: "internship",
  posted_date: "2026-08-01",
  application_url: "https://example.com/apply",
  status: "active",
};

const NEW_MATCH_ROW = {
  id: "match-1",
  opportunity_source_id: SOURCE_ID,
  match_score: 81,
  eligibility_status: "eligible",
  match_breakdown: {},
  inbox_status: "new",
  is_priority: false,
  promoted_opportunity_id: null,
};

function makeSupabaseMock(
  opts: {
    candidate?: { id: string } | null;
    applications?: { data: unknown; error: { message: string } | null };
    opportunities?: { data: unknown; error: { message: string } | null };
    matches?: { data: unknown; error: { message: string } | null };
    sources?: { data: unknown; error: { message: string } | null };
    freshness?: { data: unknown; error: { message: string } | null };
    // Gate R3
    resumeMatches?: { data: unknown; error: { message: string } | null };
    activeResumes?: { data: unknown; error: { message: string } | null };
  } = {},
) {
  const {
    candidate = { id: CANDIDATE_ID },
    applications = { data: [], error: null },
    opportunities = { data: [], error: null },
    matches = { data: [NEW_MATCH_ROW], error: null },
    sources = { data: [ACTIVE_SOURCE_ROW], error: null },
    freshness = { data: [{ last_seen_at: "2026-08-29T09:00:00Z" }], error: null },
    resumeMatches = { data: [], error: null },
    activeResumes = { data: [], error: null },
  } = opts;

  const from = (table: string) => {
    if (table === "candidate") {
      return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
    }
    if (table === "application") return { select: () => queryResult(applications.data, applications.error) };
    if (table === "opportunity") return { select: () => queryResult(opportunities.data, opportunities.error) };
    if (table === "opportunity_match") {
      // Gate R3: this table now serves two different SELECT shapes — the
      // candidate-level query (OPPORTUNITY_MATCH_COLUMNS, no resume_id)
      // and the resume-scoped query (RESUME_SCOPED_MATCH_COLUMNS, which
      // appends ", resume_id"). Dispatched on the columns string, same
      // technique already used for opportunity_source's two shapes below
      // — the route itself never confuses these two queries with each
      // other, so neither should the mock.
      return {
        select: (cols: string) =>
          cols.includes("resume_id") ? queryResult(resumeMatches.data, resumeMatches.error) : queryResult(matches.data, matches.error),
      };
    }
    if (table === "resume") return { select: () => queryResult(activeResumes.data, activeResumes.error) };
    if (table === "opportunity_source") {
      // Two distinct queries against this table (see today.ts): the
      // freshness fetch selects only "last_seen_at"; the per-match-source
      // fetch selects the full OPPORTUNITY_SOURCE_COLUMNS list. Dispatch
      // on the columns string so each gets its own mock data.
      return {
        select: (cols: string) =>
          cols === "last_seen_at" ? queryResult(freshness.data, freshness.error) : queryResult(sources.data, sources.error),
      };
    }
    return queryResult([], null);
  };

  return { from } as any;
}

describe("GET /today — feed_summary wiring", () => {
  it("includes a feed_summary built from the candidate's own opportunity_match + opportunity_source rows", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as {
      feed_summary: { new_matches_count: number; top_matches: unknown[]; last_ingested_at: string | null };
    };
    expect(body.feed_summary.new_matches_count).toBe(1);
    expect(body.feed_summary.top_matches).toHaveLength(1);
    expect((body.feed_summary.top_matches[0] as { title: string }).title).toBe("Backend Engineering Intern");
    expect(body.feed_summary.last_ingested_at).toBe("2026-08-29T09:00:00Z");
  });

  it("feed_summary is empty but last_ingested_at is still populated when the candidate has zero opportunity_match rows", async () => {
    const supabase = makeSupabaseMock({ matches: { data: [], error: null } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as {
      feed_summary: { new_matches_count: number; top_matches: unknown[]; last_ingested_at: string | null };
    };
    expect(body.feed_summary).toEqual({
      new_matches_count: 0,
      top_matches: [],
      last_ingested_at: "2026-08-29T09:00:00Z",
      resume_highlights: [],
    });
  });

  it("last_ingested_at is null (not an error) when ingestion has never produced any visible opportunity_source row", async () => {
    const supabase = makeSupabaseMock({ freshness: { data: [], error: null } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { feed_summary: { last_ingested_at: string | null } };
    expect(body.feed_summary.last_ingested_at).toBeNull();
  });

  it("returns 400 when the freshness fetch itself fails", async () => {
    const supabase = makeSupabaseMock({ freshness: { data: null, error: { message: "db unreachable" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("today_fetch_failed");
  });

  it("with zero matches, opportunity_source is queried once for freshness only — never for the full per-match column list", async () => {
    const sourceSelect = vi.fn((cols: string) => queryResult(cols === "last_seen_at" ? [{ last_seen_at: "2026-08-29T09:00:00Z" }] : [], null));
    const supabase = makeSupabaseMock({ matches: { data: [], error: null } });
    const originalFrom = supabase.from;
    supabase.from = (table: string) => {
      if (table === "opportunity_source") return { select: sourceSelect };
      return originalFrom(table);
    };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(sourceSelect).toHaveBeenCalledTimes(1);
    expect(sourceSelect).toHaveBeenCalledWith("last_seen_at");
  });

  it("returns 400 (not a partial/degraded 200) when the opportunity_match fetch fails", async () => {
    const supabase = makeSupabaseMock({ matches: { data: null, error: { message: "connection reset" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("today_fetch_failed");
  });

  it("returns 400 when the opportunity_source fetch fails", async () => {
    const supabase = makeSupabaseMock({ sources: { data: null, error: { message: "timeout" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("today_fetch_failed");
  });

  it("still returns 404 candidate_not_found before ever touching opportunity_match/opportunity_source", async () => {
    const supabase = makeSupabaseMock({ candidate: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("existing behavior (applications/opportunities -> deadlines/action items) is unaffected by the feed_summary addition", async () => {
    const supabase = makeSupabaseMock({
      applications: {
        data: [
          {
            id: "app-1",
            opportunity_id: "opp-1",
            status: "SAVED",
            applied_at: null,
            deadline_override: null,
            next_action_date: null,
            next_action_note: null,
            updated_at: "2026-08-01T00:00:00Z",
          },
        ],
        error: null,
      },
      opportunities: {
        data: [
          {
            id: "opp-1",
            title: "Data Intern",
            company: "Beta Inc",
            application_url: null,
            deadline_date: "2026-08-30",
            inbox_status: "new",
            is_priority: false,
          },
        ],
        error: null,
      },
      matches: { data: [], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { deadlines_approaching: unknown[] };
    expect(body.deadlines_approaching).toHaveLength(1);
  });

  // ── Gate R3 ──────────────────────────────────────────────────────────

  it("Gate R3: the candidate-level opportunity_match query filters resume_id IS NULL — the correctness fix this gate made", async () => {
    const isSpy = vi.fn();
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
        if (table === "application") return { select: () => queryResult([], null) };
        if (table === "opportunity") return { select: () => queryResult([], null) };
        if (table === "resume") return { select: () => queryResult([], null) };
        if (table === "opportunity_match") {
          return {
            select: (cols: string) => {
              if (cols.includes("resume_id")) return queryResult([], null); // resume-scoped query
              const qr = queryResult([NEW_MATCH_ROW], null);
              const originalIs = qr.is as (...args: unknown[]) => unknown;
              qr.is = (...args: unknown[]) => {
                isSpy(...args);
                return originalIs(...args);
              };
              return qr;
            },
          };
        }
        if (table === "opportunity_source") {
          return {
            select: (cols: string) =>
              cols === "last_seen_at" ? queryResult([{ last_seen_at: "2026-08-29T09:00:00Z" }], null) : queryResult([ACTIVE_SOURCE_ROW], null),
          };
        }
        return queryResult([], null);
      },
    };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(isSpy).toHaveBeenCalledWith("resume_id", null);
  });

  it("Gate R3: resume_highlights reflects each active resume's own scoped matches, joined against the same active sources", async () => {
    const RESUME_ID = "resume-1";
    const RESUME_SOURCE_ID = "source-resume-1";
    const RESUME_SOURCE_ROW = { ...ACTIVE_SOURCE_ROW, id: RESUME_SOURCE_ID, title: "AI Research Intern" };
    const RESUME_MATCH_ROW = {
      id: "match-resume-1",
      opportunity_source_id: RESUME_SOURCE_ID,
      match_score: 92,
      eligibility_status: "eligible",
      match_breakdown: {},
      inbox_status: "new",
      is_priority: false,
      promoted_opportunity_id: null,
      resume_id: RESUME_ID,
    };
    const supabase = makeSupabaseMock({
      activeResumes: { data: [{ id: RESUME_ID, label: "AI/ML", target_role_category: "Machine Learning" }], error: null },
      resumeMatches: { data: [RESUME_MATCH_ROW], error: null },
      sources: { data: [ACTIVE_SOURCE_ROW, RESUME_SOURCE_ROW], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as {
      feed_summary: {
        resume_highlights: Array<{
          resume_id: string;
          label: string;
          target_role_category: string | null;
          new_matches_count: number;
          top_matches: Array<{ title: string }>;
        }>;
      };
    };
    expect(body.feed_summary.resume_highlights).toEqual([
      {
        resume_id: RESUME_ID,
        label: "AI/ML",
        target_role_category: "Machine Learning",
        new_matches_count: 1,
        top_matches: [expect.objectContaining({ title: "AI Research Intern" })],
      },
    ]);
    // The flat feed_summary (candidate-level) is unaffected by the resume's own matches.
    expect(body.feed_summary).toHaveProperty("new_matches_count", 1); // from the default NEW_MATCH_ROW
  });

  it("Gate R3: an active resume with zero matches still appears in resume_highlights, not omitted", async () => {
    const supabase = makeSupabaseMock({
      activeResumes: { data: [{ id: "resume-empty", label: "Data Science", target_role_category: null }], error: null },
      resumeMatches: { data: [], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    const body = res.body as { feed_summary: { resume_highlights: Array<{ resume_id: string; new_matches_count: number }> } };
    expect(body.feed_summary.resume_highlights).toEqual([
      { resume_id: "resume-empty", label: "Data Science", target_role_category: null, new_matches_count: 0, top_matches: [] },
    ]);
  });

  it("Gate R3: returns 400 when the resume-scoped opportunity_match fetch fails", async () => {
    const supabase = makeSupabaseMock({ resumeMatches: { data: null, error: { message: "connection reset" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("today_fetch_failed");
  });

  it("Gate R3: returns 400 when the active-resume list fetch fails", async () => {
    const supabase = makeSupabaseMock({ activeResumes: { data: null, error: { message: "timeout" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("today_fetch_failed");
  });

  it("Gate R3: no active resumes -> resume_highlights is [] and no resume/resume-scoped-match wiring changes the flat feed_summary", async () => {
    const supabase = makeSupabaseMock(); // activeResumes defaults to []
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    const body = res.body as { feed_summary: { resume_highlights: unknown[]; new_matches_count: number } };
    expect(body.feed_summary.resume_highlights).toEqual([]);
    expect(body.feed_summary.new_matches_count).toBe(1); // unchanged from the pre-Gate-R3 baseline test above
  });
});

// ── Phase B2 — daily_queue wiring ─────────────────────────────────────
//
// B2 is purely additive: buildDailyQueue() (lib/dailyQueue.ts) itself is
// already fully unit-tested (tests/dailyQueue.test.ts) against every
// membership/ordering/cap/dedup rule. These tests only prove the
// integration boundary — that GET /today actually threads the caller's
// own action_required + candidate-scoped opportunity_match/
// opportunity_source rows into that unmodified function and returns the
// result as an additive `daily_queue` field — not a re-test of the
// algorithm itself.
describe("GET /today — daily_queue (Phase B2)", () => {
  it("daily_queue is present and is an array on a normal authenticated response", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { daily_queue: unknown };
    expect(Array.isArray(body.daily_queue)).toBe(true);
  });

  it("includes an action-required item (a follow-up overdue by construction, regardless of when the suite runs)", async () => {
    const supabase = makeSupabaseMock({
      applications: {
        data: [
          {
            id: "app-follow-up",
            opportunity_id: "opp-follow-up",
            status: "APPLIED",
            applied_at: null,
            deadline_override: null,
            // Far enough in the past that it is always overdue, independent
            // of the actual date the test suite runs on.
            next_action_date: "2000-01-01",
            next_action_note: "Call recruiter",
            updated_at: "2000-01-01T00:00:00Z",
          },
        ],
        error: null,
      },
      opportunities: {
        data: [
          {
            id: "opp-follow-up",
            title: "Platform Intern",
            company: "Gamma LLC",
            application_url: null,
            deadline_date: null,
            inbox_status: "new",
            is_priority: false,
          },
        ],
        error: null,
      },
      matches: { data: [], error: null }, // isolate: no opportunity-match items in this case
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as {
      action_required: Array<{ application_id: string }>;
      daily_queue: Array<{ reason: string; id: string }>;
    };
    // Sanity: this fixture really does produce an action_required item —
    // otherwise this test would trivially pass for the wrong reason.
    expect(body.action_required.some((a) => a.application_id === "app-follow-up")).toBe(true);
    expect(body.daily_queue).toContainEqual(expect.objectContaining({ reason: "action_required", id: "app-follow-up" }));
  });

  it("includes an eligible, untriaged opportunity match (the default NEW_MATCH_ROW/ACTIVE_SOURCE_ROW fixture)", async () => {
    const supabase = makeSupabaseMock({
      applications: { data: [], error: null },
      opportunities: { data: [], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { daily_queue: Array<{ reason: string; id: string }> };
    expect(body.daily_queue).toContainEqual(expect.objectContaining({ reason: "match", id: "match-1" }));
  });

  it("caps daily_queue at 5 items even when more than 5 are eligible", async () => {
    const manyMatches = Array.from({ length: 8 }, (_, i) => ({
      id: `match-${i}`,
      opportunity_source_id: `source-${i}`,
      match_score: 10 + i,
      eligibility_status: "eligible",
      match_breakdown: {},
      inbox_status: "new",
      is_priority: false,
      promoted_opportunity_id: null,
    }));
    const manySources = Array.from({ length: 8 }, (_, i) => ({
      ...ACTIVE_SOURCE_ROW,
      id: `source-${i}`,
      title: `Role ${i}`,
      company: `Company ${i}`,
    }));
    const supabase = makeSupabaseMock({
      applications: { data: [], error: null },
      opportunities: { data: [], error: null },
      matches: { data: manyMatches, error: null },
      sources: { data: manySources, error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { daily_queue: unknown[] };
    expect(body.daily_queue).toHaveLength(5);
  });

  it("existing Today fields (stats, action_required, deadlines_approaching, feed_summary, pipeline_summary, generated_at) are untouched by daily_queue", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as Record<string, unknown>;
    for (const field of [
      "generated_at",
      "action_required",
      "deadlines_approaching",
      "follow_ups_due",
      "saved_opportunities",
      "recently_applied",
      "pipeline_summary",
      "feed_summary",
      "stats",
      "daily_queue",
    ]) {
      expect(body).toHaveProperty(field);
    }
    // Same feed_summary behavior as the pre-B2 baseline test above —
    // daily_queue is additive, it does not change this shape.
    const feedSummary = body.feed_summary as { new_matches_count: number };
    expect(feedSummary.new_matches_count).toBe(1);
  });

  it("returns daily_queue: [] (never null/omitted) for a candidate with nothing eligible", async () => {
    const supabase = makeSupabaseMock({
      applications: { data: [], error: null },
      opportunities: { data: [], error: null },
      matches: { data: [], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { daily_queue: unknown[] };
    expect(body.daily_queue).toEqual([]);
  });

  it("candidate isolation: the opportunity_match query feeding daily_queue is scoped to THIS request's own resolved candidate id, via the same candidate_id filter used everywhere else on this route — no second identity mechanism", async () => {
    const eqSpy = vi.fn();

    function supabaseFor(candidateId: string) {
      return {
        from: (table: string) => {
          if (table === "candidate") return { select: () => ({ single: async () => ({ data: { id: candidateId }, error: null }) }) };
          if (table === "application") return { select: () => queryResult([], null) };
          if (table === "opportunity") return { select: () => queryResult([], null) };
          if (table === "resume") return { select: () => queryResult([], null) };
          if (table === "opportunity_match") {
            return {
              select: (cols: string) => {
                if (cols.includes("resume_id")) return queryResult([], null);
                const qr = queryResult([NEW_MATCH_ROW], null);
                const originalEq = qr.eq as (...args: unknown[]) => unknown;
                qr.eq = (...args: unknown[]) => {
                  eqSpy(candidateId, ...args);
                  return originalEq(...args);
                };
                return qr;
              },
            };
          }
          if (table === "opportunity_source") {
            return {
              select: (cols: string) =>
                cols === "last_seen_at"
                  ? queryResult([{ last_seen_at: "2026-08-29T09:00:00Z" }], null)
                  : queryResult([ACTIVE_SOURCE_ROW], null),
            };
          }
          return queryResult([], null);
        },
      };
    }

    const reqA = { supabase: supabaseFor("cand-A") } as unknown as AuthedRequest;
    const resA = makeRes();
    await runRoute(getHandlers("get", "/today"), reqA, resA);

    const reqB = { supabase: supabaseFor("cand-B") } as unknown as AuthedRequest;
    const resB = makeRes();
    await runRoute(getHandlers("get", "/today"), reqB, resB);

    // Each request's opportunity_match query (the same one that feeds both
    // feed_summary and daily_queue) was filtered by that SAME request's own
    // resolved candidate id — never the other request's.
    expect(eqSpy).toHaveBeenCalledWith("cand-A", "candidate_id", "cand-A");
    expect(eqSpy).toHaveBeenCalledWith("cand-B", "candidate_id", "cand-B");
    expect(eqSpy).not.toHaveBeenCalledWith("cand-A", "candidate_id", "cand-B");
    expect(eqSpy).not.toHaveBeenCalledWith("cand-B", "candidate_id", "cand-A");

    // And both responses' daily_queue reflect only their own request's data
    // (both happen to see the same mock match row here, but each was
    // produced from that request's own independently-scoped fetch, not a
    // shared/leaked one).
    expect((resA.body as { daily_queue: unknown[] }).daily_queue.length).toBeGreaterThan(0);
    expect((resB.body as { daily_queue: unknown[] }).daily_queue.length).toBeGreaterThan(0);
  });
});
