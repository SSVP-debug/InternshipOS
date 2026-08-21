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

function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  opportunityLookup?: { data: unknown; error: { message: string } | null };
  applicationInsert?: { data: unknown; error: { message: string; code?: string } | null };
  applicationBefore?: { data: unknown; error: { message: string } | null };
  applicationUpdate?: { data: unknown; error: { message: string; code?: string } | null };
  statusEventInsert?: ReturnType<typeof vi.fn>;
}) {
  const {
    candidate = { id: "cand-1" },
    opportunityLookup = { data: { id: OPP_UUID }, error: null },
    applicationInsert = { data: { id: VALID_UUID, opportunity_id: OPP_UUID, status: "SAVED" }, error: null },
    applicationBefore = { data: { id: VALID_UUID, status: "APPLIED" }, error: null },
    applicationUpdate = { data: { id: VALID_UUID, status: "INTERVIEW" }, error: null },
    statusEventInsert = vi.fn(),
  } = opts;

  let applicationCallCount = 0;

  return {
    from(table: string) {
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      if (table === "opportunity") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => opportunityLookup }) }) };
      }
      if (table === "application") {
        applicationCallCount++;
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => (applicationCallCount === 1 ? applicationBefore : applicationUpdate),
            }),
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
        return { insert: statusEventInsert.mockReturnValue(queryResult(null, null)) };
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
