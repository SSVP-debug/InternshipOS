import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { workAuthorizationRouter } from "../src/routes/work-authorization.js";

// Regression coverage for the diagnosed bug: GET /work-authorization used
// to return HTTP 404 with { error: "work_authorization_not_found" } when
// the candidate simply hadn't filled the section in yet — a normal, first-
// load empty state, not an error. That 404 body has no `message` field, so
// the frontend's error fallback (errBody.message ?? errBody.error)
// surfaced the raw code "work_authorization_not_found" as literal text on
// screen. The fix mirrors GET /profile's existing convention: a missing
// singleton is a 200 with the field set to null, never a 404. This suite
// locks that in and proves POST/PUT's OWN legitimate 404/409 "business
// error" cases (a different, correctly-404/409 concept — creating a
// duplicate, or updating something that doesn't exist yet) were not
// accidentally changed alongside the GET fix.

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post" | "put", path: string) {
  const router = workAuthorizationRouter() as unknown as { stack: RouteLayer[] };
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
  return res;
}

const CANDIDATE_ID = "cand-1";

const EXISTING_ROW = {
  candidate_id: CANDIDATE_ID,
  citizenship_country: "IN",
  status: "f1_opt",
  requires_sponsorship: true,
  work_auth_expiry_date: null,
  notes: null,
  updated_at: "2026-08-01T00:00:00Z",
};

const VALID_BODY = { citizenship_country: "IN", status: "f1_opt", requires_sponsorship: true };

function candidateTableMock() {
  return { select: () => ({ single: async () => ({ data: { id: CANDIDATE_ID }, error: null }) }) };
}

describe("GET /work-authorization", () => {
  function makeSupabaseGetMock(result: { data: unknown; error: { message: string } | null }) {
    return {
      from: (table: string) => {
        if (table !== "work_authorization") throw new Error(`unexpected table: ${table}`);
        return { select: () => ({ maybeSingle: async () => result }) };
      },
    };
  }

  it("returns 200 with work_authorization: null when no row exists yet (the fix)", async () => {
    const supabase = makeSupabaseGetMock({ data: null, error: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ work_authorization: null });
    expect(res.status).not.toHaveBeenCalledWith(404); // explicitly not the old behavior
  });

  it("returns 200 with the existing row when one exists", async () => {
    const supabase = makeSupabaseGetMock({ data: EXISTING_ROW, error: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ work_authorization: EXISTING_ROW });
  });

  it("surfaces a genuine Supabase error as 400, not silently, and never as a fabricated 404", async () => {
    const supabase = makeSupabaseGetMock({ data: null, error: { message: "connection reset" } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.body as { message: string }).message).toBe("connection reset");
  });
});

describe("POST /work-authorization — own 409 semantics are unchanged", () => {
  it("still returns 409 when a row already exists (POST is create-only)", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") return candidateTableMock();
        if (table === "work_authorization") {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    const req = { supabase, body: VALID_BODY } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("still returns 201 on a successful create", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") return candidateTableMock();
        if (table === "work_authorization") {
          return { insert: () => ({ select: () => ({ single: async () => ({ data: EXISTING_ROW, error: null }) }) }) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    const req = { supabase, body: VALID_BODY } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("PUT /work-authorization — own 404 semantics are unchanged", () => {
  it("still returns 404 when updating a row that doesn't exist yet (a real business error, distinct from GET's empty-state case)", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") return candidateTableMock();
        if (table === "work_authorization") {
          return {
            update: () => ({
              eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    const req = { supabase, body: VALID_BODY } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("still returns 200 on a successful update", async () => {
    const supabase = {
      from: (table: string) => {
        if (table === "candidate") return candidateTableMock();
        if (table === "work_authorization") {
          return {
            update: () => ({
              eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: EXISTING_ROW, error: null }) }) }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    const req = { supabase, body: VALID_BODY } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/work-authorization"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
