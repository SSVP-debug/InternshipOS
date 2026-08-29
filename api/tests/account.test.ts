import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { loadEnv } from "../src/lib/env.js";

// account.ts imports adminClient from supabaseClient.js and calls it
// (adminClient(env)) inside the DELETE /account handler. Mocking the whole
// module before importing accountRouter means that call never touches a
// real Supabase project — this is the one route in the whole API where
// that's necessary, since every other route only ever uses the per-request
// user-scoped client already passed in on req.supabase.
const deleteUserMock = vi.fn();
vi.mock("../src/lib/supabaseClient.js", () => ({
  adminClient: vi.fn(() => ({
    auth: { admin: { deleteUser: deleteUserMock } },
  })),
}));

const { accountRouter } = await import("../src/routes/account.js");

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "delete", path: string) {
  // loadEnv() (not a hand-typed partial literal) so this never drifts out
  // of sync with Env's actual required fields again — this is exactly the
  // kind of drift that went unnoticed because tests/ isn't covered by any
  // tsc invocation (see PROGRESS_SESSION.md 1f); using the same
  // already-established pattern as app.test.ts closes that gap here.
  const router = accountRouter(
    loadEnv({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      PORT: "3000",
      CONSENT_POLICY_VERSION: "v1.0",
    } as NodeJS.ProcessEnv)
  ) as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(
  handlers: ((req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown)[],
  req: AuthedRequest,
  res: Response
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

// Builds a thenable that also exposes .maybeSingle() — matches how
// account.ts calls each sub-table: multi-row tables are awaited directly
// off .eq(...), single-row tables (personal_info, work_authorization) call
// .maybeSingle() on the same .eq(...) result.
function queryResult(data: unknown, error: { message: string } | null = null) {
  const result = { data, error };
  const thenable = Promise.resolve(result) as Promise<typeof result> & {
    maybeSingle: () => Promise<typeof result>;
  };
  thenable.maybeSingle = async () => result;
  return thenable;
}

function makeExportSupabaseMock(opts: {
  candidate?: { id: string; profile_status: string } | null;
  tableResults?: Record<string, { data: unknown; error: { message: string } | null }>;
}) {
  const { candidate = { id: "cand-1", profile_status: "active" }, tableResults = {} } = opts;

  return {
    from(table: string) {
      if (table === "candidate") {
        return {
          select: () => ({
            single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }),
          }),
        };
      }
      const entry = tableResults[table] ?? { data: table === "personal_info" || table === "work_authorization" ? null : [], error: null };
      return {
        select: () => ({
          eq: () => queryResult(entry.data, entry.error),
        }),
      };
    },
  };
}

beforeEach(() => {
  deleteUserMock.mockReset();
});

describe("GET /export", () => {
  it("returns 404 when the caller has no candidate row", async () => {
    const supabase = makeExportSupabaseMock({ candidate: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/export"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns a full export with every Phase-0 table represented", async () => {
    const supabase = makeExportSupabaseMock({
      tableResults: {
        personal_info: { data: { legal_first_name: "Alice" }, error: null },
        consent_record: { data: [{ consent_type: "data_processing" }], error: null },
        education: { data: [{ id: "edu-1" }], error: null },
        work_authorization: { data: { status: "authorized" }, error: null },
        skill: { data: [{ id: "skill-1" }], error: null },
        project: { data: [{ id: "proj-1" }], error: null },
        experience: { data: [{ id: "exp-1" }], error: null },
        achievement: { data: [{ id: "ach-1" }], error: null },
        certification: { data: [{ id: "cert-1" }], error: null },
        evidence_source: { data: [{ id: "ev-1" }], error: null },
        claim: { data: [{ id: "claim-1" }], error: null },
      },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/export"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as Record<string, unknown>;
    expect(body.candidate).toMatchObject({ id: "cand-1" });
    expect(body.personal_info).toMatchObject({ legal_first_name: "Alice" });
    expect(body.work_authorization).toMatchObject({ status: "authorized" });
    expect(body.education).toEqual([{ id: "edu-1" }]);
    expect(body.claims).toEqual([{ id: "claim-1" }]);
    expect(body.evidence_sources).toEqual([{ id: "ev-1" }]);
    expect(typeof body.exported_at).toBe("string");
  });

  it("returns null (not an error) for personal_info/work_authorization when the candidate hasn't set them yet", async () => {
    const supabase = makeExportSupabaseMock({}); // no tableResults overrides -> defaults to null/[]
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/export"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as Record<string, unknown>;
    expect(body.personal_info).toBeNull();
    expect(body.work_authorization).toBeNull();
    expect(body.skills).toEqual([]);
  });

  it("returns 400 export_failed when any sub-table query errors", async () => {
    const supabase = makeExportSupabaseMock({
      tableResults: {
        claim: { data: null, error: { message: "connection reset" } },
      },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/export"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "export_failed" });
  });
});

describe("DELETE /account", () => {
  it("returns 401 when the caller's session cannot be resolved", async () => {
    const supabase = { auth: { getUser: async () => ({ data: { user: null }, error: { message: "no session" } }) } };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/account"), req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it("deletes the caller's own auth.users row and returns 204", async () => {
    deleteUserMock.mockResolvedValue({ error: null });
    const supabase = { auth: { getUser: async () => ({ data: { user: { id: "auth-user-1" } }, error: null }) } };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/account"), req, res);

    expect(deleteUserMock).toHaveBeenCalledWith("auth-user-1");
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 400 account_deletion_failed when the admin API call errors", async () => {
    deleteUserMock.mockResolvedValue({ error: { message: "admin API unavailable" } });
    const supabase = { auth: { getUser: async () => ({ data: { user: { id: "auth-user-1" } }, error: null }) } };
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/account"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "account_deletion_failed" });
  });
});
