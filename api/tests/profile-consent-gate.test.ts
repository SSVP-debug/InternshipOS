import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import { profileRouter } from "../src/routes/profile.js";
import type { AuthedRequest } from "../src/middleware/auth.js";

// This suite proves the *wiring*: that requireConsent("data_processing")
// actually sits in front of the POST /profile handler (not just that the
// middleware works in isolation, which requireConsent.test.ts covers), and
// that GET /profile is deliberately left ungated. Rather than pull in
// supertest/msw (neither is a declared dependency — see package.json), the
// route's own Express Router stack is read directly and its handlers run
// in sequence, which is enough to exercise the real middleware -> handler
// chain with no network or HTTP server involved.

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post", path: string) {
  const router = profileRouter() as unknown as { stack: RouteLayer[] };
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

function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  consent?: { id: string } | null;
  personalInfo?: Record<string, unknown> | null;
  upsertError?: { message: string } | null;
}) {
  const { candidate = { id: "cand-1" }, consent = null, personalInfo = null, upsertError = null } = opts;
  const upsertCalls: unknown[] = [];

  return {
    __upsertCalls: upsertCalls,
    from(table: string) {
      if (table === "candidate") {
        return {
          select: () => ({
            single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }),
          }),
        };
      }
      if (table === "consent_record") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({ data: consent, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "personal_info") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: personalInfo, error: null }),
            }),
          }),
          upsert: (payload: unknown) => {
            upsertCalls.push(payload);
            return Promise.resolve({ error: upsertError });
          },
        };
      }
      throw new Error(`unexpected table in test double: ${table}`);
    },
  };
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

const validBody = {
  legal_first_name: "Alice",
  legal_last_name: "Nguyen",
  email: "alice@example.edu",
  location_country: "US",
};

describe("POST /profile — consent gate wiring", () => {
  it("blocks the write with 403 when the caller has no active data_processing consent", async () => {
    const supabase = makeSupabaseMock({ consent: null });
    const req = { supabase, body: validBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ error: "consent_required" });
    expect(supabase.__upsertCalls).toHaveLength(0); // never reached the write
  });

  it("blocks with 403 before even validating the request body", async () => {
    const supabase = makeSupabaseMock({ consent: null });
    const req = { supabase, body: { garbage: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).not.toMatchObject({ error: "invalid_request" });
  });

  it("allows the write through when the caller has an active data_processing consent", async () => {
    const supabase = makeSupabaseMock({ consent: { id: "consent-1" } });
    const req = { supabase, body: validBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__upsertCalls).toHaveLength(1);
    expect(supabase.__upsertCalls[0]).toMatchObject({ candidate_id: "cand-1", ...validBody });
  });
});

describe("GET /profile — not gated by consent", () => {
  it("returns the candidate's own data with no active consent present", async () => {
    const supabase = makeSupabaseMock({ consent: null, personalInfo: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ candidate: { id: "cand-1" }, personal_info: null });
  });
});
