import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { screeningAnswerRouter } from "../src/routes/screening-answer.js";

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

const ANSWER_ID = "88888888-8888-4888-8888-888888888888";

function getHandlers(method: "get" | "post" | "put" | "delete", path: string) {
  const router = screeningAnswerRouter() as unknown as { stack: RouteLayer[] };
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

function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.order = self;
  builder.maybeSingle = async () => result;
  builder.single = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

interface MockOpts {
  candidate?: { id: string } | null;
  listResult?: { data: unknown; error: unknown };
  getResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
  deleteResult?: { data: unknown; error: unknown };
  insertSpy?: (payload: unknown) => unknown;
}

function makeSupabaseMock(opts: MockOpts = {}) {
  const {
    candidate = { id: "cand-1" },
    listResult = { data: [], error: null },
    getResult = { data: null, error: null },
    insertResult = { data: { id: ANSWER_ID, question: "Q", answer: "A" }, error: null },
    updateResult = { data: { id: ANSWER_ID, question: "Q2", answer: "A2" }, error: null },
    deleteResult = { data: { id: ANSWER_ID }, error: null },
    insertSpy,
  } = opts;

  return {
    from(table: string) {
      if (table !== "screening_answer" && table !== "candidate") {
        throw new Error(`unexpected table in mock: ${table}`);
      }
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      return {
        select: (_cols?: string) => {
          const builder = chainable(listResult);
          // GET (list): .select().order() resolves via `then`. GET one /
          // PUT / DELETE: .select().eq().maybeSingle() / .single().
          builder.eq = () => chainable(getResult);
          return builder;
        },
        insert: (payload: unknown) => {
          insertSpy?.(payload);
          return chainable(insertResult);
        },
        update: () => ({ eq: () => chainable(updateResult) }),
        delete: () => ({ eq: () => chainable(deleteResult) }),
      };
    },
  };
}

describe("GET /screening-answers", () => {
  it("returns the caller's own entries, newest first", async () => {
    const rows = [{ id: ANSWER_ID, question: "Q", answer: "A" }];
    const supabase = makeSupabaseMock({ listResult: { data: rows, error: null } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/screening-answers"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as unknown as { body: { screening_answers: unknown } }).body.screening_answers).toEqual(rows);
  });

  it("surfaces a Supabase error as 400", async () => {
    const supabase = makeSupabaseMock({ listResult: { data: null, error: { message: "connection reset" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/screening-answers"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("GET /screening-answers/:id", () => {
  it("returns 404 for a nonexistent (or not-owned, via RLS) id", async () => {
    const supabase = makeSupabaseMock({ getResult: { data: null, error: null } });
    const req = { supabase, params: { id: ANSWER_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/screening-answers/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 400 for a non-UUID id", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: "not-a-uuid" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/screening-answers/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("POST /screening-answers", () => {
  it("creates an entry scoped to the caller's own candidate_id", async () => {
    const insertSpy = vi.fn();
    const supabase = makeSupabaseMock({ insertSpy });
    const req = { supabase, body: { question: "Willing to relocate?", answer: "Yes" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/screening-answers"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ candidate_id: "cand-1", question: "Willing to relocate?", answer: "Yes" }));
  });

  it("rejects an invalid body with 400 before ever calling insert", async () => {
    const insertSpy = vi.fn();
    const supabase = makeSupabaseMock({ insertSpy });
    const req = { supabase, body: { question: "", answer: "Yes" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/screening-answers"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("PUT /screening-answers/:id", () => {
  it("updates and returns the row", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: ANSWER_ID }, body: { question: "Q2", answer: "A2" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/screening-answers/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 404 when RLS makes the update a no-op (cross-candidate id)", async () => {
    const supabase = makeSupabaseMock({ updateResult: { data: null, error: null } });
    const req = { supabase, params: { id: ANSWER_ID }, body: { question: "Q2", answer: "A2" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/screening-answers/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("DELETE /screening-answers/:id", () => {
  it("deletes and returns 204", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: ANSWER_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/screening-answers/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 404 when nothing was deleted", async () => {
    const supabase = makeSupabaseMock({ deleteResult: { data: null, error: null } });
    const req = { supabase, params: { id: ANSWER_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/screening-answers/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
