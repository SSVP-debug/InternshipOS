import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { opportunityFeedRouter } from "../src/routes/opportunity-feed.js";

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "patch", path: string) {
  const router = opportunityFeedRouter() as unknown as { stack: RouteLayer[] };
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

// Chainable thenable mimicking the subset of the supabase-js query builder
// used by opportunity-feed.ts: .select().eq()/.in()/.order()/.limit(),
// terminal .single()/.maybeSingle(), and directly-awaitable via .then() —
// same pattern as application.route.test.ts.
function queryResult(data: unknown, error: { message: string; code?: string } | null = null) {
  const result = { data, error };
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.in = self;
  builder.order = self;
  builder.limit = self;
  builder.update = self;
  builder.single = async () => result;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

const CANDIDATE_ID = "cand-1";
const MATCH_ID = "11111111-1111-1111-1111-111111111111";
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

const MATCH_ROW = {
  id: MATCH_ID,
  opportunity_source_id: SOURCE_ID,
  match_score: 72,
  eligibility_status: "unknown",
  match_breakdown: { breakdown: {}, reasons: ["Skill match: python"], missing: [], unknown: [] },
  inbox_status: "new",
  is_priority: false,
};

function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  matchList?: { data: unknown; error: { message: string } | null };
  sourceList?: { data: unknown; error: { message: string } | null };
  updateResult?: { data: unknown; error: { message: string } | null };
} = {}) {
  const {
    candidate = { id: CANDIDATE_ID },
    matchList = { data: [MATCH_ROW], error: null },
    sourceList = { data: [ACTIVE_SOURCE_ROW], error: null },
    updateResult = { data: { ...MATCH_ROW, inbox_status: "saved" }, error: null },
  } = opts;

  const fromSpy = vi.fn();

  const from = (table: string) => {
    fromSpy(table);
    if (table === "candidate") {
      return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
    }
    if (table === "opportunity_match") {
      return {
        select: () => queryResult(matchList.data, matchList.error),
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: async () => updateResult }),
            }),
          }),
        }),
      };
    }
    if (table === "opportunity_source") {
      return { select: () => queryResult(sourceList.data, sourceList.error) };
    }
    return queryResult([], null);
  };

  return { from, fromSpy };
}

describe("GET /opportunity-feed", () => {
  it("resolves the authenticated candidate before querying anything else", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(supabase.fromSpy).toHaveBeenCalledWith("candidate");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("scopes the opportunity_match query to the resolved candidate", async () => {
    const eqSpy = vi.fn();
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") {
          return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
        }
        if (table === "opportunity_match") {
          return {
            select: () => {
              const qr = queryResult([MATCH_ROW], null);
              const originalEq = qr.eq as (...args: unknown[]) => unknown;
              qr.eq = (...args: unknown[]) => {
                eqSpy(...args);
                return originalEq(...args);
              };
              return qr;
            },
          };
        }
        if (table === "opportunity_source") {
          return { select: () => queryResult([ACTIVE_SOURCE_ROW], null) };
        }
        return queryResult([], null);
      },
    };

    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(eqSpy).toHaveBeenCalledWith("candidate_id", CANDIDATE_ID);
  });

  it("queries only active opportunity_source rows for the referenced ids", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(supabase.fromSpy).toHaveBeenCalledWith("opportunity_source");
  });

  it("returns { generated_at, items } built via buildOpportunityFeed, honoring the 50-item limit call", async () => {
    const limitSpy = vi.fn();
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") {
          return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
        }
        if (table === "opportunity_match") {
          return {
            select: () => {
              const qr = queryResult([MATCH_ROW], null);
              const originalLimit = qr.limit as (...args: unknown[]) => unknown;
              qr.limit = (...args: unknown[]) => {
                limitSpy(...args);
                return originalLimit(...args);
              };
              return qr;
            },
          };
        }
        if (table === "opportunity_source") {
          return { select: () => queryResult([ACTIVE_SOURCE_ROW], null) };
        }
        return queryResult([], null);
      },
    };

    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(limitSpy).toHaveBeenCalledWith(50);
    const body = res.body as { generated_at: string; items: unknown[] };
    expect(typeof body.generated_at).toBe("string");
    expect(body.items).toHaveLength(1);
    expect((body.items[0] as { title: string }).title).toBe("Backend Engineering Intern");
    expect((body.items[0] as { match_score: number }).match_score).toBe(72);
  });

  it("returns an empty items array (no crash) when the candidate has no matches", async () => {
    const supabase = makeSupabaseMock({ matchList: { data: [], error: null } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    const body = res.body as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("returns 404 when the caller has no candidate row", async () => {
    const supabase = makeSupabaseMock({ candidate: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("surfaces a Supabase error on the opportunity_match query as a 400, not a thrown/unhandled error", async () => {
    const supabase = makeSupabaseMock({ matchList: { data: null, error: { message: "connection reset" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { message: string }).message).toBe("connection reset");
  });

  it("surfaces a Supabase error on the opportunity_source query as a 400", async () => {
    const supabase = makeSupabaseMock({ sourceList: { data: null, error: { message: "timeout" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("PATCH /opportunity-matches/:id/inbox", () => {
  it("accepts a valid inbox_status update and returns the updated row", async () => {
    const supabase = makeSupabaseMock();
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { inbox_status: "saved" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.body as { opportunity_match: { inbox_status: string } }).opportunity_match.inbox_status).toBe("saved");
  });

  it("scopes the update to both id and the caller's own candidate_id", async () => {
    const eqCalls: unknown[][] = [];
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") {
          return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
        }
        if (table === "opportunity_match") {
          return {
            update: () => ({
              eq: (...a1: unknown[]) => {
                eqCalls.push(a1);
                return {
                  eq: (...a2: unknown[]) => {
                    eqCalls.push(a2);
                    return { select: () => ({ maybeSingle: async () => ({ data: { ...MATCH_ROW }, error: null }) }) };
                  },
                };
              },
            }),
          };
        }
        return queryResult([], null);
      },
    };

    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { is_priority: true },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(eqCalls).toContainEqual(["id", MATCH_ID]);
    expect(eqCalls).toContainEqual(["candidate_id", CANDIDATE_ID]);
  });

  it("rejects an invalid body with 400 before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { inbox_status: "not_a_real_status" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(supabase.fromSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed id with 400 before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = {
      supabase,
      params: { id: "not-a-uuid" },
      body: { inbox_status: "saved" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(supabase.fromSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when no row matches both id and candidate_id (not found or not owned)", async () => {
    const supabase = makeSupabaseMock({ updateResult: { data: null, error: null } });
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { inbox_status: "dismissed" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("surfaces a Supabase update error as a 400, not a thrown/unhandled error", async () => {
    const supabase = makeSupabaseMock({ updateResult: { data: null, error: { message: "constraint violation" } } });
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { inbox_status: "saved" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
