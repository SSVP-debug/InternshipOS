import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { applicationRouter } from "../src/routes/application.js";

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post" | "put" | "patch", path: string) {
  const router = applicationRouter() as unknown as { stack: RouteLayer[] };
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
// used by application.ts: .select().eq()/.in()/.order() and terminal
// .single()/.maybeSingle(), all awaitable directly (matches truth-center's
// and account's mock pattern).
function queryResult(data: unknown, error: { message: string; code?: string } | null = null) {
  const result = { data, error };
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.in = self;
  builder.order = self;
  builder.update = self;
  builder.insert = self;
  builder.single = async () => result;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

const VALID_UUID = "11111111-1111-1111-1111-111111111111";
const OPP_UUID = "22222222-2222-2222-2222-222222222222";
const RESUME_UUID = "33333333-3333-3333-3333-333333333333";

function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  opportunityLookup?: { data: unknown; error: { message: string } | null };
  applicationInsert?: { data: unknown; error: { message: string; code?: string } | null };
  applicationBefore?: { data: unknown; error: { message: string } | null };
  applicationUpdate?: { data: unknown; error: { message: string; code?: string } | null };
  statusEventInsert?: ReturnType<typeof vi.fn>;
  // Gate R4
  resumeLookup?: { data: unknown; error: { message: string } | null };
  applicationList?: { data: unknown; error: { message: string } | null };
} = {}) {
  const {
    candidate = { id: "cand-1" },
    opportunityLookup = { data: { id: OPP_UUID }, error: null },
    applicationInsert = { data: { id: VALID_UUID, opportunity_id: OPP_UUID, resume_id: null, status: "SAVED" }, error: null },
    applicationBefore = { data: { id: VALID_UUID, status: "APPLIED" }, error: null },
    applicationUpdate = { data: { id: VALID_UUID, status: "INTERVIEW" }, error: null },
    statusEventInsert = vi.fn(),
    resumeLookup = { data: { id: RESUME_UUID }, error: null },
    applicationList = { data: [], error: null },
  } = opts;

  let applicationCallCount = 0;

  return {
    from(table: string) {
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      if (table === "opportunity") {
        // Supports both shapes used across this route: the single-lookup
        // ownership check (.eq("id", id).maybeSingle(), used by POST) and
        // the list-enrichment fetch (.in("id", ids), used by GET
        // /applications and GET /applications/:id) — the latter had no
        // test coverage before Gate R4 added it.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => opportunityLookup }),
            in: () => queryResult(opportunityLookup.data ? [opportunityLookup.data] : [], opportunityLookup.error),
          }),
        };
      }
      if (table === "resume") {
        // Gate R4: this same mock serves the POST/PUT ownership-check
        // (.eq("id", resumeId).maybeSingle()) AND — for GET
        // /applications and GET /applications/:id — the resume
        // enrichment fetches. resumeLookup's default of { id:
        // RESUME_UUID } (no label/target_role_category/
        // evidence_source_id) is deliberately minimal: it's enough for
        // every ownership-check test, and enrichment-specific tests
        // override it with a fuller row via the `resumeLookup` option.
        return { select: () => ({ eq: () => ({ maybeSingle: async () => resumeLookup }), in: () => queryResult([resumeLookup.data].filter(Boolean), resumeLookup.error) }) };
      }
      if (table === "application") {
        applicationCallCount++;
        return {
          // GET /applications/:id and PATCH .../status both do
          // select().eq(id).maybeSingle() — applicationBefore is reused
          // for a single-row GET test's expected data too (this mock
          // predates GET route coverage and this reuse avoids adding yet
          // another option; the name is PATCH-specific but the shape is
          // identical either way).
          select: () => ({
            eq: () => ({
              maybeSingle: async () => (applicationCallCount === 1 ? applicationBefore : applicationUpdate),
            }),
            // GET /applications (list) — select(cols).order(...), no .eq()
            // unless a status filter is supplied (not exercised by any
            // current test).
            order: () => queryResult(applicationList.data, applicationList.error),
          }),
          insert: () => queryResult(applicationInsert.data, applicationInsert.error),
          update: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: async () => applicationUpdate }),
            }),
          }),
        };
      }
      if (table === "application_status_event") {
        // Supports both the PATCH /status write (.insert(...)) and the
        // GET /applications/:id history read (.select().eq().order()) —
        // the latter had no test coverage before Gate R4 added GET tests.
        return { insert: statusEventInsert.mockReturnValue(queryResult(null, null)), select: () => queryResult([], null) };
      }
      return queryResult([], null);
    },
  };
}

describe("POST /applications — ownership check on opportunity_id", () => {
  it("returns 404 (not 400/403) when the opportunity does not belong to the caller (or doesn't exist)", async () => {
    const supabase = makeSupabaseMock({ opportunityLookup: { data: null, error: null } });
    const req = { supabase, body: { opportunity_id: OPP_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("opportunity_not_found");
  });

  it("returns 404 when the caller has no candidate row", async () => {
    const supabase = makeSupabaseMock({ candidate: null });
    const req = { supabase, body: { opportunity_id: OPP_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("candidate_not_found");
  });

  it("returns 400 for an invalid request body (missing opportunity_id)", async () => {
    const supabase = makeSupabaseMock({});
    const req = { supabase, body: {} } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("maps a unique_violation (23505) from a duplicate application to 409, not 400", async () => {
    const supabase = makeSupabaseMock({
      applicationInsert: { data: null, error: { message: "duplicate key value", code: "23505" } },
    });
    const req = { supabase, body: { opportunity_id: OPP_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res as unknown as { body: { error: string } }).body.error).toBe(
      "application_already_exists_for_opportunity",
    );
  });

  it("writes an initial application_status_event on successful creation", async () => {
    const statusEventInsert = vi.fn();
    const supabase = makeSupabaseMock({ statusEventInsert });
    const req = { supabase, body: { opportunity_id: OPP_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(statusEventInsert).toHaveBeenCalledWith(
      expect.objectContaining({ from_status: null, to_status: "SAVED" }),
    );
  });

  // ── Gate R4: resume_id ──────────────────────────────────────────────

  it("Gate R4: creates successfully with a resume_id that belongs to the caller", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, body: { opportunity_id: OPP_UUID, resume_id: RESUME_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("Gate R4: returns 404 resume_not_found when resume_id doesn't belong to the caller (or doesn't exist)", async () => {
    const supabase = makeSupabaseMock({ resumeLookup: { data: null, error: null } });
    const req = { supabase, body: { opportunity_id: OPP_UUID, resume_id: RESUME_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("resume_not_found");
  });

  it("Gate R4: creating without resume_id at all never touches the resume table (no unnecessary ownership check)", async () => {
    const resumeSelect = vi.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: RESUME_UUID }, error: null }) }) }));
    const supabase = makeSupabaseMock();
    const originalFrom = supabase.from;
    supabase.from = (table: string) => (table === "resume" ? { select: resumeSelect } : originalFrom(table));
    const req = { supabase, body: { opportunity_id: OPP_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(resumeSelect).not.toHaveBeenCalled();
  });
});

describe("PUT /applications/:id — resume_id correction (Gate R4)", () => {
  it("sets resume_id when it belongs to the caller", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: VALID_UUID }, body: { resume_id: RESUME_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/applications/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 404 resume_not_found when the new resume_id doesn't belong to the caller", async () => {
    const supabase = makeSupabaseMock({ resumeLookup: { data: null, error: null } });
    const req = { supabase, params: { id: VALID_UUID }, body: { resume_id: RESUME_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/applications/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("resume_not_found");
  });

  it("clearing resume_id with an explicit null never touches the resume table (nothing to own-check)", async () => {
    const resumeSelect = vi.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }));
    const supabase = makeSupabaseMock();
    const originalFrom = supabase.from;
    supabase.from = (table: string) => (table === "resume" ? { select: resumeSelect } : originalFrom(table));
    const req = { supabase, params: { id: VALID_UUID }, body: { resume_id: null } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/applications/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resumeSelect).not.toHaveBeenCalled();
  });

  it("omitting resume_id entirely leaves it untouched — never touches the resume table", async () => {
    const resumeSelect = vi.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }));
    const supabase = makeSupabaseMock();
    const originalFrom = supabase.from;
    supabase.from = (table: string) => (table === "resume" ? { select: resumeSelect } : originalFrom(table));
    const req = { supabase, params: { id: VALID_UUID }, body: { next_action_note: "Following up." } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/applications/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(resumeSelect).not.toHaveBeenCalled();
  });
});

describe("GET /applications and /applications/:id — resume enrichment (Gate R4)", () => {
  it("GET /applications: each application is enriched with its resume summary (label, target_role_category)", async () => {
    const supabase = makeSupabaseMock({
      applicationList: {
        data: [{ id: VALID_UUID, opportunity_id: OPP_UUID, resume_id: RESUME_UUID, status: "SAVED" }],
        error: null,
      },
      resumeLookup: { data: { id: RESUME_UUID, label: "Software Development", target_role_category: "Software Engineering" }, error: null },
    });
    const req = { supabase, query: {} } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/applications"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { applications: Array<{ resume: { label: string } | null }> };
    expect(body.applications[0].resume).toEqual({
      id: RESUME_UUID,
      label: "Software Development",
      target_role_category: "Software Engineering",
    });
  });

  it("GET /applications: an application with no resume_id gets resume: null, not omitted or errored", async () => {
    const supabase = makeSupabaseMock({
      applicationList: { data: [{ id: VALID_UUID, opportunity_id: OPP_UUID, resume_id: null, status: "SAVED" }], error: null },
    });
    const req = { supabase, query: {} } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/applications"), req, res);

    const body = res.body as { applications: Array<{ resume: unknown }> };
    expect(body.applications[0].resume).toBeNull();
  });

  it("GET /applications/:id: enriches with the resume's evidence_source_id — the actual file, not just the label", async () => {
    const supabase = makeSupabaseMock({
      applicationBefore: { data: { id: VALID_UUID, opportunity_id: OPP_UUID, resume_id: RESUME_UUID, status: "SAVED" }, error: null },
      resumeLookup: {
        data: { id: RESUME_UUID, label: "AI/ML", target_role_category: "Machine Learning", evidence_source_id: "evidence-1" },
        error: null,
      },
    });
    const req = { supabase, params: { id: VALID_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/applications/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { application: { resume: { evidence_source_id: string } | null } };
    expect(body.application.resume).toEqual({
      id: RESUME_UUID,
      label: "AI/ML",
      target_role_category: "Machine Learning",
      evidence_source_id: "evidence-1",
    });
  });

  it("GET /applications/:id: an application with no resume_id never even queries the resume table", async () => {
    const resumeSelect = vi.fn(() => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }));
    const supabase = makeSupabaseMock({
      applicationBefore: { data: { id: VALID_UUID, opportunity_id: OPP_UUID, resume_id: null, status: "SAVED" }, error: null },
    });
    const originalFrom = supabase.from;
    supabase.from = (table: string) => (table === "resume" ? { select: resumeSelect } : originalFrom(table));
    const req = { supabase, params: { id: VALID_UUID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/applications/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { application: { resume: unknown } };
    expect(body.application.resume).toBeNull();
    expect(resumeSelect).not.toHaveBeenCalled();
  });
});

describe("PATCH /applications/:id/status — transition error mapping", () => {
  it("maps a check_violation (23514) from an illegal transition to 409, not 400", async () => {
    const supabase = makeSupabaseMock({
      applicationUpdate: { data: null, error: { message: "invalid application status transition", code: "23514" } },
    });
    const req = {
      supabase,
      params: { id: VALID_UUID },
      body: { status: "SAVED" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/applications/:id/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("invalid_status_transition");
  });

  it("returns 404 when the application does not exist / isn't owned by the caller", async () => {
    const supabase = makeSupabaseMock({ applicationBefore: { data: null, error: null } });
    const req = {
      supabase,
      params: { id: VALID_UUID },
      body: { status: "APPLYING" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/applications/:id/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 400 for an invalid request body (bad status value)", async () => {
    const supabase = makeSupabaseMock({});
    const req = { supabase, params: { id: VALID_UUID }, body: { status: "GHOSTED" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/applications/:id/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("writes a status event with from_status/to_status/note when the status actually changes", async () => {
    const statusEventInsert = vi.fn();
    const supabase = makeSupabaseMock({
      statusEventInsert,
      applicationBefore: { data: { id: VALID_UUID, status: "APPLIED" }, error: null },
      applicationUpdate: { data: { id: VALID_UUID, status: "INTERVIEW" }, error: null },
    });
    const req = {
      supabase,
      params: { id: VALID_UUID },
      body: { status: "INTERVIEW", note: "Onsite scheduled." },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/applications/:id/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(statusEventInsert).toHaveBeenCalledWith(
      expect.objectContaining({ from_status: "APPLIED", to_status: "INTERVIEW", note: "Onsite scheduled." }),
    );
  });

  it("does NOT write a status event when the status is unchanged (same-status no-op PATCH)", async () => {
    const statusEventInsert = vi.fn();
    const supabase = makeSupabaseMock({
      statusEventInsert,
      applicationBefore: { data: { id: VALID_UUID, status: "APPLIED" }, error: null },
      applicationUpdate: { data: { id: VALID_UUID, status: "APPLIED" }, error: null },
    });
    const req = {
      supabase,
      params: { id: VALID_UUID },
      body: { status: "APPLIED" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/applications/:id/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(statusEventInsert).not.toHaveBeenCalled();
  });
});
