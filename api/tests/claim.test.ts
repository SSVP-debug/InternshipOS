import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { claimRouter } from "../src/routes/claim.js";

// Same router-introspection harness as truth-center.test.ts — no HTTP
// server, no real Supabase; just exercises the route handlers directly
// against a mocked req.supabase.

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post" | "put" | "patch", path: string) {
  const router = claimRouter() as unknown as { stack: RouteLayer[] };
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

function queryResult(data: unknown, error: { message: string; code?: string } | null = null) {
  return Promise.resolve({ data, error });
}

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

// entityTables: table name -> row that exists there (or undefined if the
// row shouldn't be found, simulating "doesn't exist" or "belongs to
// another candidate" — both surface identically through RLS-scoped
// req.supabase, per subjectEntityExists' design).
function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  entityTables?: Record<string, Record<string, unknown> | null>;
  insertResult?: { data: unknown; error: { message: string; code?: string } | null };
  updateResult?: { data: unknown; error: { message: string; code?: string } | null };
}) {
  const { candidate = { id: "cand-1" }, entityTables = {}, insertResult, updateResult } = opts;

  return {
    from(table: string) {
      if (table === "candidate") {
        return {
          select: () => ({
            single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }),
          }),
        };
      }
      if (table === "claim") {
        return {
          insert: () => ({
            select: () => ({
              single: async () => insertResult ?? { data: null, error: { message: "unexpected insert" } },
            }),
          }),
          update: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => updateResult ?? { data: null, error: { message: "unexpected update" } },
              }),
            }),
          }),
        };
      }
      // Any other table is a subject-entity lookup: select(idColumn).eq(idColumn, id).maybeSingle()
      const row = entityTables[table];
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => queryResult(row ?? null),
          }),
        }),
      };
    },
  };
}

describe("POST /claims — subject_entity_id existence check (Gate 0)", () => {
  it("returns 400 subject_entity_not_found when the referenced project doesn't exist (or isn't the caller's)", async () => {
    const supabase = makeSupabaseMock({ entityTables: { project: null } });
    const req = {
      supabase,
      body: { subject_entity_type: "project", subject_entity_id: VALID_UUID, claim_text: "Built a thing." },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/claims"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "subject_entity_not_found" });
  });

  it("proceeds to insert when the referenced project exists", async () => {
    const insertedClaim = { id: "claim-1", subject_entity_type: "project", subject_entity_id: VALID_UUID };
    const supabase = makeSupabaseMock({
      entityTables: { project: { id: VALID_UUID } },
      insertResult: { data: insertedClaim, error: null },
    });
    const req = {
      supabase,
      body: { subject_entity_type: "project", subject_entity_id: VALID_UUID, claim_text: "Built a thing." },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/claims"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toMatchObject({ claim: insertedClaim });
  });

  it("looks up work_authorization by candidate_id, not id", async () => {
    const supabase = makeSupabaseMock({
      entityTables: { work_authorization: { candidate_id: VALID_UUID } },
      insertResult: { data: { id: "claim-1" }, error: null },
    });
    const req = {
      supabase,
      body: {
        subject_entity_type: "work_authorization",
        subject_entity_id: VALID_UUID,
        claim_text: "I am authorized to work in the US.",
      },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/claims"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns 404 candidate_not_found without attempting insert when the caller has no candidate row (existence check already passed)", async () => {
    const supabase = makeSupabaseMock({
      candidate: null,
      entityTables: { project: { id: VALID_UUID } },
    });
    const req = {
      supabase,
      body: { subject_entity_type: "project", subject_entity_id: VALID_UUID, claim_text: "Built a thing." },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/claims"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ error: "candidate_not_found" });
  });
});

describe("PUT /claims/:id — subject_entity_id existence check (Gate 0)", () => {
  it("returns 400 subject_entity_not_found when re-pointing a claim at a nonexistent skill", async () => {
    const supabase = makeSupabaseMock({ entityTables: { skill: null } });
    const req = {
      supabase,
      params: { id: VALID_UUID },
      body: { subject_entity_type: "skill", subject_entity_id: OTHER_UUID, claim_text: "Proficient in Rust." },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/claims/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "subject_entity_not_found" });
  });

  it("proceeds to update when the referenced skill exists", async () => {
    const updatedClaim = { id: VALID_UUID, subject_entity_type: "skill", subject_entity_id: OTHER_UUID };
    const supabase = makeSupabaseMock({
      entityTables: { skill: { id: OTHER_UUID } },
      updateResult: { data: updatedClaim, error: null },
    });
    const req = {
      supabase,
      params: { id: VALID_UUID },
      body: { subject_entity_type: "skill", subject_entity_id: OTHER_UUID, claim_text: "Proficient in Rust." },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/claims/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ claim: updatedClaim });
  });
});
