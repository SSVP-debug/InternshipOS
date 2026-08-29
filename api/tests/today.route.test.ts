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
  builder.single = async () => result;
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
  } = {},
) {
  const {
    candidate = { id: CANDIDATE_ID },
    applications = { data: [], error: null },
    opportunities = { data: [], error: null },
    matches = { data: [NEW_MATCH_ROW], error: null },
    sources = { data: [ACTIVE_SOURCE_ROW], error: null },
  } = opts;

  const from = (table: string) => {
    if (table === "candidate") {
      return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
    }
    if (table === "application") return { select: () => queryResult(applications.data, applications.error) };
    if (table === "opportunity") return { select: () => queryResult(opportunities.data, opportunities.error) };
    if (table === "opportunity_match") return { select: () => queryResult(matches.data, matches.error) };
    if (table === "opportunity_source") return { select: () => queryResult(sources.data, sources.error) };
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
    const body = res.body as { feed_summary: { new_matches_count: number; top_matches: unknown[] } };
    expect(body.feed_summary.new_matches_count).toBe(1);
    expect(body.feed_summary.top_matches).toHaveLength(1);
    expect((body.feed_summary.top_matches[0] as { title: string }).title).toBe("Backend Engineering Intern");
  });

  it("feed_summary is empty (not an error) when the candidate has zero opportunity_match rows", async () => {
    const supabase = makeSupabaseMock({ matches: { data: [], error: null } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { feed_summary: { new_matches_count: number; top_matches: unknown[] } };
    expect(body.feed_summary).toEqual({ new_matches_count: 0, top_matches: [] });
  });

  it("does not fetch opportunity_source at all when there are zero matches (no wasted query)", async () => {
    const sourceSelect = vi.fn(() => queryResult([], null));
    const supabase = makeSupabaseMock({ matches: { data: [], error: null } });
    const originalFrom = supabase.from;
    supabase.from = (table: string) => {
      if (table === "opportunity_source") return { select: sourceSelect };
      return originalFrom(table);
    };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/today"), req, res);

    expect(sourceSelect).not.toHaveBeenCalled();
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
});
