import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import { profileRouter } from "../src/routes/profile.js";
import type { AuthedRequest } from "../src/middleware/auth.js";

// Companion to profile-consent-gate.test.ts. That file proves the consent
// gate's wiring; this one proves the profile_status behavior added
// alongside it: the auto 'incomplete' -> 'active' transition on POST
// /profile, and the new PATCH /profile/status route. Same "read the real
// Express Router stack and run its handlers directly" approach — no
// supertest/msw, see the other file's header comment for why.

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post" | "patch", path: string) {
  const router = profileRouter() as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

// Unlike profile-consent-gate.test.ts's version of this helper, this one
// also awaits an explicit "response sent" signal (see makeRes below), not
// just the outer middleware call's own promise. requireConsent.ts calls
// `next()` without awaiting it — correct for real Express, which never
// awaits a middleware's return value either — but it means the outer
// `await handlers[0](...)` here can resolve before a deeper handler
// (one that needs more await hops, like POST /profile's new conditional
// profile_status update) has actually finished and called res.json. The
// other test file's routes are shallow enough that this race happens to
// resolve in the right order; POST /profile's extra hop here does not, so
// this file waits for the real signal instead of relying on that timing.
async function runRoute(
  handlers: ((req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown)[],
  req: AuthedRequest,
  res: Response & { __done: Promise<void> }
) {
  let index = 0;
  const next = async (err?: unknown) => {
    if (err) throw err;
    index++;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await handlers[0](req, res, next);
  await res.__done;
}

function makeSupabaseMock(opts: {
  candidate?: { id: string; profile_status: string } | null;
  consent?: { id: string } | null;
  upsertError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const {
    candidate = { id: "cand-1", profile_status: "active" },
    consent = { id: "consent-1" },
    upsertError = null,
    updateError = null,
  } = opts;
  const updateCalls: unknown[] = [];

  return {
    __updateCalls: updateCalls,
    from(table: string) {
      if (table === "candidate") {
        return {
          select: () => ({
            single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }),
          }),
          update: (payload: unknown) => {
            updateCalls.push(payload);
            return { eq: async () => ({ error: updateError }) };
          },
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
          upsert: () => Promise.resolve({ error: upsertError }),
        };
      }
      throw new Error(`unexpected table in test double: ${table}`);
    },
  };
}

function makeRes() {
  let signalDone: () => void;
  const done = new Promise<void>((resolve) => {
    signalDone = resolve;
  });
  const res = {} as Response & { statusCode?: number; body?: unknown; __done?: Promise<void> };
  res.__done = done;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    signalDone();
    return res;
  }) as unknown as Response["json"];
  return res as Response & { statusCode?: number; body?: unknown; __done: Promise<void> };
}

const validProfileBody = {
  legal_first_name: "Alice",
  legal_last_name: "Nguyen",
  email: "alice@example.edu",
  location_country: "US",
};

describe("POST /profile — auto-activation of profile_status", () => {
  it("flips 'incomplete' -> 'active' on a successful save", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "incomplete" } });
    const req = { supabase, body: validProfileBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__updateCalls).toEqual([{ profile_status: "active" }]);
  });

  it("does not touch profile_status when it is already 'active'", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "active" } });
    const req = { supabase, body: validProfileBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__updateCalls).toHaveLength(0);
  });

  it("does NOT reactivate a candidate who has explicitly paused", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "paused" } });
    const req = { supabase, body: validProfileBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__updateCalls).toHaveLength(0);
  });

  it("does NOT reactivate a candidate who has archived their profile", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "archived" } });
    const req = { supabase, body: validProfileBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__updateCalls).toHaveLength(0);
  });

  it("still returns 200 even if the auto-activation update itself fails (non-fatal)", async () => {
    const supabase = makeSupabaseMock({
      candidate: { id: "cand-1", profile_status: "incomplete" },
      updateError: { message: "connection reset" },
    });
    const req = { supabase, body: validProfileBody } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/profile"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("PATCH /profile/status", () => {
  it("rejects a body with an invalid profile_status value", async () => {
    const supabase = makeSupabaseMock({});
    const req = { supabase, body: { profile_status: "incomplete" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "invalid_request" });
    expect(supabase.__updateCalls).toHaveLength(0);
  });

  it("transitions 'active' -> 'paused'", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "active" } });
    const req = { supabase, body: { profile_status: "paused" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ profile_status: "paused" });
    expect(supabase.__updateCalls).toEqual([{ profile_status: "paused" }]);
  });

  it("transitions 'paused' -> 'active'", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "paused" } });
    const req = { supabase, body: { profile_status: "active" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__updateCalls).toEqual([{ profile_status: "active" }]);
  });

  it("allows transitioning to 'archived' from 'active'", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "active" } });
    const req = { supabase, body: { profile_status: "archived" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(supabase.__updateCalls).toEqual([{ profile_status: "archived" }]);
  });

  it("blocks any transition once a profile is 'archived' — terminal via this endpoint", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "archived" } });
    const req = { supabase, body: { profile_status: "active" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ error: "profile_archived" });
    expect(supabase.__updateCalls).toHaveLength(0);
  });

  it("is a no-op (200, no write) when the requested status matches the current one", async () => {
    const supabase = makeSupabaseMock({ candidate: { id: "cand-1", profile_status: "paused" } });
    const req = { supabase, body: { profile_status: "paused" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ message: "profile status unchanged", profile_status: "paused" });
    expect(supabase.__updateCalls).toHaveLength(0);
  });

  it("404s when the caller has no candidate row", async () => {
    const supabase = makeSupabaseMock({ candidate: null });
    const req = { supabase, body: { profile_status: "paused" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("patch", "/profile/status"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("is NOT gated by requireConsent — no consent check runs before it", async () => {
    // makeSupabaseMock's consent_record branch would throw if ever queried
    // with an unexpected shape; more directly, this route's handler chain
    // should be exactly [handler] with no requireConsent middleware in
    // front of it.
    const handlers = getHandlers("patch", "/profile/status");
    expect(handlers).toHaveLength(1);
  });
});
