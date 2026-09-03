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

function getHandlers(method: "get" | "patch" | "post", path: string) {
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
  // Gate R3: .is("resume_id", null) / .not("resume_id", "is", null) — same
  // no-op-chain-but-still-resolve-to-`result` treatment as .eq/.in/.order
  // above; these tests assert on the resolved data, not on exactly which
  // filter methods PostgREST received (that's covered by the dedicated
  // eqSpy/isSpy-style tests below where the distinction actually matters).
  builder.is = self;
  builder.not = self;
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
  ownedOpportunity?: { data: unknown; error: { message: string } | null };
  // Gate R3
  activeResumeList?: { data: unknown; error: { message: string } | null };
  resumeOwnership?: { data: unknown; error: { message: string } | null };
  resumeScopedMatchList?: { data: unknown; error: { message: string } | null };
} = {}) {
  const {
    candidate = { id: CANDIDATE_ID },
    matchList = { data: [MATCH_ROW], error: null },
    sourceList = { data: [ACTIVE_SOURCE_ROW], error: null },
    updateResult = { data: { ...MATCH_ROW, inbox_status: "saved" }, error: null },
    ownedOpportunity = { data: { id: "owned-opportunity-1" }, error: null },
    activeResumeList = { data: [], error: null },
    resumeOwnership = { data: { id: "resume-1" }, error: null },
    resumeScopedMatchList = { data: [], error: null },
  } = opts;

  const fromSpy = vi.fn();

  const from = (table: string) => {
    fromSpy(table);
    if (table === "candidate") {
      return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
    }
    if (table === "opportunity_match") {
      return {
        // Gate R3: this table now serves two different SELECT shapes —
        // the items query (OPPORTUNITY_MATCH_COLUMNS) and the
        // resume_groups counting query (a short, hand-written column
        // list). Distinguished here by inspecting the columns string
        // passed to .select(), since that's the only signal available —
        // the actual route never gives these two queries a chance to be
        // confused with each other (see opportunity-feed.ts's own
        // comments on why they're kept as separate queries).
        select: (cols: string) =>
          cols.includes("resume_id, opportunity_source_id, eligibility_status")
            ? queryResult(resumeScopedMatchList.data, resumeScopedMatchList.error)
            : queryResult(matchList.data, matchList.error),
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
    if (table === "opportunity") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ownedOpportunity }) }) };
    }
    if (table === "resume") {
      // Gate R3: .eq("id", ...) is the ?resume_id ownership check
      // (terminal .maybeSingle()); .eq("is_active", true) is the
      // resume_groups list (implicitly awaited, no .maybeSingle()).
      // Distinguished by which column .eq() was called with, since that's
      // exactly how the route itself decides which query it's building.
      return {
        select: () => ({
          eq: (col: string) =>
            col === "id" ? { maybeSingle: async () => resumeOwnership } : Promise.resolve(activeResumeList),
        }),
      };
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

  // ── Gate R3 ──────────────────────────────────────────────────────────

  it("Gate R3: with no active resumes, resume_groups is an empty array — payload otherwise unchanged", async () => {
    const supabase = makeSupabaseMock(); // activeResumeList defaults to []
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    const body = res.body as { resume_groups: unknown[] };
    expect(body.resume_groups).toEqual([]);
  });

  it("Gate R3: default request (no ?resume_id) queries items with resume_id IS NULL, not filtered by a specific resume", async () => {
    const isSpy = vi.fn();
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") {
          return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
        }
        if (table === "opportunity_match") {
          return {
            select: (cols: string) => {
              if (cols.includes("resume_id, opportunity_source_id")) return queryResult([], null);
              const qr = queryResult([MATCH_ROW], null);
              const originalIs = qr.is as (...args: unknown[]) => unknown;
              qr.is = (...args: unknown[]) => {
                isSpy(...args);
                return originalIs(...args);
              };
              return qr;
            },
          };
        }
        if (table === "opportunity_source") return { select: () => queryResult([ACTIVE_SOURCE_ROW], null) };
        if (table === "resume") return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
        return queryResult([], null);
      },
    };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(isSpy).toHaveBeenCalledWith("resume_id", null);
  });

  it("Gate R3: ?resume_id=<uuid> filters items to that resume, after confirming ownership", async () => {
    const RESUME_ID = "88888888-8888-8888-8888-888888888888";
    const eqSpy = vi.fn();
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") {
          return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
        }
        if (table === "resume") {
          return {
            select: () => ({
              eq: (col: string, val: string) => {
                eqSpy(col, val);
                return { maybeSingle: async () => ({ data: { id: RESUME_ID }, error: null }) };
              },
            }),
          };
        }
        if (table === "opportunity_match") {
          return {
            select: (cols: string) => {
              if (cols.includes("resume_id, opportunity_source_id")) return queryResult([], null);
              const qr = queryResult([{ ...MATCH_ROW }], null);
              const originalEq = qr.eq as (...args: unknown[]) => unknown;
              qr.eq = (...args: unknown[]) => {
                eqSpy(...args);
                return originalEq(...args);
              };
              return qr;
            },
          };
        }
        if (table === "opportunity_source") return { select: () => queryResult([ACTIVE_SOURCE_ROW], null) };
        return queryResult([], null);
      },
    };
    const req = { supabase, query: { resume_id: RESUME_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // The ownership lookup itself (resume table) uses .eq("id", RESUME_ID).
    expect(eqSpy).toHaveBeenCalledWith("id", RESUME_ID);
  });

  it("Gate R3: an unowned/nonexistent ?resume_id is a 404, not an empty feed", async () => {
    const supabase = makeSupabaseMock({ resumeOwnership: { data: null, error: null } });
    const req = { supabase, query: { resume_id: "88888888-8888-8888-8888-888888888888" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.body as { error: string }).error).toBe("resume_not_found");
  });

  it("Gate R3: a malformed ?resume_id is a 400 before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, query: { resume_id: "not-a-uuid" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("invalid_resume_id");
    expect(supabase.fromSpy).not.toHaveBeenCalledWith("resume");
  });

  it("Gate R3: resume_groups summarizes total/eligible matches per active resume, counting only rows against still-active opportunities", async () => {
    const RESUME_A = "99999999-9999-9999-9999-999999999999";
    const OTHER_SOURCE_ID = "source-2-archived";
    const supabase = makeSupabaseMock({
      activeResumeList: {
        data: [{ id: RESUME_A, label: "Software Development", target_role_category: "Software Engineering" }],
        error: null,
      },
      resumeScopedMatchList: {
        data: [
          { resume_id: RESUME_A, opportunity_source_id: SOURCE_ID, eligibility_status: "eligible" },
          { resume_id: RESUME_A, opportunity_source_id: SOURCE_ID, eligibility_status: "unknown" },
          // References a source that never comes back from the
          // opportunity_source query (i.e. no longer active) — must NOT
          // be counted, same rule buildOpportunityFeed applies to items.
          { resume_id: RESUME_A, opportunity_source_id: OTHER_SOURCE_ID, eligibility_status: "eligible" },
        ],
        error: null,
      },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/opportunity-feed"), req, res);

    const body = res.body as {
      resume_groups: Array<{ resume_id: string; label: string; total_matches: number; eligible_matches: number }>;
    };
    expect(body.resume_groups).toEqual([
      {
        resume_id: RESUME_A,
        label: "Software Development",
        target_role_category: "Software Engineering",
        total_matches: 2,
        eligible_matches: 1,
      },
    ]);
  });

  it("Gate R3: surfaces a Supabase error on the active-resume list query as a 400", async () => {
    const supabase = makeSupabaseMock({ activeResumeList: { data: null, error: { message: "connection reset" } } });
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

  const OWNED_OPPORTUNITY_ID = "22222222-2222-2222-2222-222222222222";

  it("accepts promoted_opportunity_id alone (no inbox_status/is_priority required)", async () => {
    const supabase = makeSupabaseMock({
      ownedOpportunity: { data: { id: OWNED_OPPORTUNITY_ID }, error: null },
      updateResult: { data: { ...MATCH_ROW, promoted_opportunity_id: OWNED_OPPORTUNITY_ID }, error: null },
    });
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { promoted_opportunity_id: OWNED_OPPORTUNITY_ID },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(
      (res.body as { opportunity_match: { promoted_opportunity_id: string } }).opportunity_match
        .promoted_opportunity_id,
    ).toBe(OWNED_OPPORTUNITY_ID);
  });

  it("rejects a promoted_opportunity_id that isn't a valid UUID with 400, before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { promoted_opportunity_id: "not-a-uuid" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(supabase.fromSpy).not.toHaveBeenCalled();
  });

  it("rejects promoted_opportunity_id for an opportunity the candidate does not own (RLS returns no row) with 400, and never attempts the update", async () => {
    const supabase = makeSupabaseMock({ ownedOpportunity: { data: null, error: null } });
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { promoted_opportunity_id: OWNED_OPPORTUNITY_ID },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("invalid_promoted_opportunity_id");
    expect(supabase.fromSpy).not.toHaveBeenCalledWith("opportunity_match");
  });

  it("surfaces a Supabase error on the opportunity ownership lookup as a 400, not a thrown/unhandled error", async () => {
    const supabase = makeSupabaseMock({ ownedOpportunity: { data: null, error: { message: "timeout" } } });
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: { promoted_opportunity_id: OWNED_OPPORTUNITY_ID },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { error: string }).error).toBe("promoted_opportunity_lookup_failed");
  });

  it("rejects an empty body with 400 — promoted_opportunity_id counts toward the 'at least one field' rule but an empty object still fails it", async () => {
    const supabase = makeSupabaseMock();
    const req = {
      supabase,
      params: { id: MATCH_ID },
      body: {},
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/opportunity-matches/:id/inbox"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(supabase.fromSpy).not.toHaveBeenCalled();
  });
});

// ── Gate R5: POST /opportunity-matches/bulk-apply ──────────────────────

const SOURCE_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SOURCE_B_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const MATCH_A_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const MATCH_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const RESUME_ID = "cccccccc-0000-0000-0000-000000000001";

const SOURCE_ROW_TEMPLATE = {
  source_type: "job_board",
  title: "Backend Intern",
  company: "Acme Corp",
  description: "Build things.",
  location: "Remote",
  work_mode: "remote",
  employment_type: "internship",
  skills: ["python"],
  application_url: "https://acme.example/apply",
  deadline_date: "2026-12-01",
  posted_date: "2026-08-01",
};

/**
 * Purpose-built mock for applyOneMatch's multi-table flow — distinct from
 * this file's other makeSupabaseMock/queryResult helpers (built for
 * GET/PATCH's simpler shapes) because bulk-apply's per-item flow touches
 * five tables with genuinely different call shapes each. Keyed by id so
 * a single mock instance can serve multi-item requests where different
 * items need different mock behavior (e.g. one match already promoted,
 * another not).
 */
function makeBulkApplyMock(opts: {
  candidate?: { id: string } | null;
  matches?: Record<string, { id: string; opportunity_source_id: string; resume_id: string | null; promoted_opportunity_id: string | null } | null>;
  existingOpportunities?: Record<string, { id: string } | null>; // keyed by opportunity_source_id
  sources?: Record<string, Record<string, unknown> | null>; // keyed by opportunity_source_id
  createOpportunityError?: { message: string; code?: string } | null;
  createApplicationError?: { message: string; code?: string } | null;
  applicationInserts?: Array<Record<string, unknown>>; // spy target
  opportunityInserts?: Array<Record<string, unknown>>; // spy target
} = {}) {
  const {
    candidate = { id: CANDIDATE_ID },
    matches = {},
    existingOpportunities = {},
    sources = {},
    createOpportunityError = null,
    createApplicationError = null,
    applicationInserts = [],
    opportunityInserts = [],
  } = opts;

  let opportunityInsertCount = 0;

  return {
    from(table: string) {
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      if (table === "opportunity_match") {
        return {
          select: () => ({
            eq: (_col1: string, matchId: string) => ({
              eq: () => ({
                maybeSingle: async () => {
                  const m = matches[matchId];
                  return { data: m ?? null, error: undefined };
                },
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({ eq: async () => ({ data: [payload], error: null }) }),
          }),
        };
      }
      if (table === "opportunity") {
        return {
          select: () => ({
            eq: (_c1: string, _candId: string) => ({
              eq: (_c2: string, sourceId: string) => ({
                maybeSingle: async () => ({ data: existingOpportunities[sourceId] ?? null, error: null }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            opportunityInsertCount++;
            opportunityInserts.push(payload);
            return {
              select: () => ({
                single: async () => {
                  if (createOpportunityError) return { data: null, error: createOpportunityError };
                  return { data: { id: `created-opportunity-${opportunityInsertCount}` }, error: null };
                },
              }),
            };
          },
        };
      }
      if (table === "opportunity_source") {
        return {
          select: () => ({
            eq: (_c: string, sourceId: string) => ({
              maybeSingle: async () => ({ data: sources[sourceId] ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === "application") {
        return {
          insert: (payload: Record<string, unknown>) => {
            applicationInserts.push(payload);
            return {
              select: () => ({
                single: async () => {
                  if (createApplicationError) return { data: null, error: createApplicationError };
                  return { data: { id: `app-${applicationInserts.length}`, status: "SAVED" }, error: null };
                },
              }),
            };
          },
        };
      }
      if (table === "application_status_event") {
        return { insert: () => queryResult(null, null) };
      }
      return queryResult([], null);
    },
  };
}

describe("POST /opportunity-matches/bulk-apply (Gate R5)", () => {
  it("returns 400 for an empty opportunity_match_ids array before touching the database", async () => {
    const supabase = makeBulkApplyMock();
    const req = { supabase, body: { opportunity_match_ids: [] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when the caller has no candidate row", async () => {
    const supabase = makeBulkApplyMock({ candidate: null });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("applies a single match: creates the opportunity from opportunity_source, promotes the match, and creates the application carrying the match's own resume_id", async () => {
    const applicationInserts: Array<Record<string, unknown>> = [];
    const opportunityInserts: Array<Record<string, unknown>> = [];
    const supabase = makeBulkApplyMock({
      matches: { [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: RESUME_ID, promoted_opportunity_id: null } },
      sources: { [SOURCE_A_ID]: { id: SOURCE_A_ID, ...SOURCE_ROW_TEMPLATE } },
      applicationInserts,
      opportunityInserts,
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { results: Array<{ status: string }>; summary: { applied: number } };
    expect(body.results).toEqual([
      expect.objectContaining({ opportunity_match_id: MATCH_A_ID, status: "applied" }),
    ]);
    expect(body.summary).toEqual({ applied: 1, already_applied: 0, failed: 0 });

    expect(opportunityInserts[0]).toEqual(
      expect.objectContaining({ candidate_id: CANDIDATE_ID, opportunity_source_id: SOURCE_A_ID, title: "Backend Intern" }),
    );
    // Gate R5's core promise: resume_id carried automatically, no client-supplied value needed.
    expect(applicationInserts[0]).toEqual(
      expect.objectContaining({ candidate_id: CANDIDATE_ID, resume_id: RESUME_ID }),
    );
  });

  it("dedup: reuses an existing opportunity for the same opportunity_source instead of creating a second one", async () => {
    const opportunityInserts: Array<Record<string, unknown>> = [];
    const supabase = makeBulkApplyMock({
      matches: { [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: null, promoted_opportunity_id: null } },
      existingOpportunities: { [SOURCE_A_ID]: { id: "already-existing-opportunity" } },
      opportunityInserts,
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    const body = res.body as { results: Array<{ opportunity_id?: string }> };
    expect(body.results[0].opportunity_id).toBe("already-existing-opportunity");
    expect(opportunityInserts).toHaveLength(0); // never created a duplicate
  });

  it("a match already promoted is reported as already_applied, not applied again", async () => {
    const supabase = makeBulkApplyMock({
      matches: {
        [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: null, promoted_opportunity_id: "prior-application-opportunity" },
      },
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    const body = res.body as { results: Array<{ status: string; opportunity_id?: string }>; summary: { already_applied: number } };
    expect(body.results[0]).toEqual(
      expect.objectContaining({ status: "already_applied", opportunity_id: "prior-application-opportunity" }),
    );
    expect(body.summary.already_applied).toBe(1);
  });

  it("a unique_violation on the application insert (existing application for the reused opportunity) is reported as already_applied, not failed", async () => {
    const supabase = makeBulkApplyMock({
      matches: { [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: null, promoted_opportunity_id: null } },
      existingOpportunities: { [SOURCE_A_ID]: { id: "already-existing-opportunity" } },
      createApplicationError: { message: "duplicate key value", code: "23505" },
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    const body = res.body as { results: Array<{ status: string }> };
    expect(body.results[0].status).toBe("already_applied");
  });

  it("a nonexistent/unowned opportunity_match_id is reported as failed, isolated from the rest of the batch", async () => {
    const supabase = makeBulkApplyMock({
      matches: {
        [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: null, promoted_opportunity_id: null },
        // MATCH_B_ID intentionally absent -> not found
      },
      sources: { [SOURCE_A_ID]: { id: SOURCE_A_ID, ...SOURCE_ROW_TEMPLATE } },
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID, MATCH_B_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    expect(res.status).toHaveBeenCalledWith(200); // partial success is still a 200 — see summary for the breakdown
    const body = res.body as { results: Array<{ opportunity_match_id: string; status: string }>; summary: Record<string, number> };
    expect(body.results).toEqual([
      expect.objectContaining({ opportunity_match_id: MATCH_A_ID, status: "applied" }),
      expect.objectContaining({ opportunity_match_id: MATCH_B_ID, status: "failed", error: "opportunity_match_not_found" }),
    ]);
    expect(body.summary).toEqual({ applied: 1, already_applied: 0, failed: 1 });
  });

  it("a removed opportunity_source (posting gone between match and apply) is reported as failed, not fabricated from partial data", async () => {
    const supabase = makeBulkApplyMock({
      matches: { [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: null, promoted_opportunity_id: null } },
      sources: { [SOURCE_A_ID]: null },
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    const body = res.body as { results: Array<{ status: string; error?: string }> };
    expect(body.results[0]).toEqual(expect.objectContaining({ status: "failed", error: "opportunity_source_not_found" }));
  });

  it("two matches for two different resumes both succeed independently, each carrying its own resume_id", async () => {
    const applicationInserts: Array<Record<string, unknown>> = [];
    const supabase = makeBulkApplyMock({
      matches: {
        [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: "resume-x", promoted_opportunity_id: null },
        [MATCH_B_ID]: { id: MATCH_B_ID, opportunity_source_id: SOURCE_B_ID, resume_id: "resume-y", promoted_opportunity_id: null },
      },
      sources: {
        [SOURCE_A_ID]: { id: SOURCE_A_ID, ...SOURCE_ROW_TEMPLATE },
        [SOURCE_B_ID]: { id: SOURCE_B_ID, ...SOURCE_ROW_TEMPLATE, title: "Data Science Intern" },
      },
      applicationInserts,
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID, MATCH_B_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    const body = res.body as { summary: Record<string, number> };
    expect(body.summary).toEqual({ applied: 2, already_applied: 0, failed: 0 });
    expect(applicationInserts.map((a) => a.resume_id)).toEqual(["resume-x", "resume-y"]);
  });

  it("maps opportunity_source.source_type 'manual_seed' to opportunity.source 'other', never 'manual' (which would misrepresent it as candidate-typed)", async () => {
    const opportunityInserts: Array<Record<string, unknown>> = [];
    const supabase = makeBulkApplyMock({
      matches: { [MATCH_A_ID]: { id: MATCH_A_ID, opportunity_source_id: SOURCE_A_ID, resume_id: null, promoted_opportunity_id: null } },
      sources: { [SOURCE_A_ID]: { id: SOURCE_A_ID, ...SOURCE_ROW_TEMPLATE, source_type: "manual_seed" } },
      opportunityInserts,
    });
    const req = { supabase, body: { opportunity_match_ids: [MATCH_A_ID] } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/opportunity-matches/bulk-apply"), req, res);

    expect(opportunityInserts[0].source).toBe("other");
  });
});
