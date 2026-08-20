// app.test.ts
// Integration tests for the Express app assembled by createApp() in
// server.ts. Deliberately exercises only routes/paths that never reach a
// real Supabase call (/healthz, unmatched paths, and the requireAuth
// 401-before-Supabase path) so this suite stays network-free like the
// rest of the vitest suite. /readyz is unit-tested against a mocked
// fetch in health.test.ts instead of here, to avoid a real network call
// in this file too.

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { loadEnv } from "../src/lib/env.js";

const baseEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
} as NodeJS.ProcessEnv;

describe("createApp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /healthz returns 200 with no dependency checks", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns the centralized 404 JSON body for an unmatched route with a bearer token present", async () => {
    // NOTE: requireAuth() is mounted ahead of every protected router as
    // blanket middleware (see server.ts) — with NO Authorization header,
    // the first requireAuth in the chain short-circuits with 401 before
    // any router gets a chance to not-match the path, so an anonymous
    // request to an unknown path gets 401, not 404 (see the dedicated
    // test below). notFoundHandler is reached once a bearer token is
    // present (requireAuth passes control through each router) but no
    // router recognizes the path.
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/this-route-does-not-exist").set("Authorization", "Bearer fake-token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", path: "/this-route-does-not-exist" });
  });

  it("returns 401 (not 404) for an unmatched route with no Authorization header, since auth is checked before routing", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/this-route-does-not-exist");
    expect(res.status).toBe(401);
  });

  it("sets baseline security headers via helmet", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/healthz");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("attaches an X-Request-Id header to every response", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/healthz");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("reuses an inbound X-Request-Id header instead of generating a new one", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/healthz").set("X-Request-Id", "test-fixed-id");
    expect(res.headers["x-request-id"]).toBe("test-fixed-id");
  });

  it("does not set Access-Control-Allow-Origin when ALLOWED_ORIGINS is unset", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/healthz").set("Origin", "https://random-site.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects an allowed origin when ALLOWED_ORIGINS includes it", async () => {
    const app = createApp(loadEnv({ ...baseEnv, ALLOWED_ORIGINS: "https://app.example.com" } as NodeJS.ProcessEnv));
    const res = await request(app).get("/healthz").set("Origin", "https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("does not reflect an origin absent from ALLOWED_ORIGINS", async () => {
    const app = createApp(loadEnv({ ...baseEnv, ALLOWED_ORIGINS: "https://app.example.com" } as NodeJS.ProcessEnv));
    const res = await request(app).get("/healthz").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects an authenticated-route request with 401 before any Supabase call is made", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/profile");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "missing_or_invalid_authorization_header" });
  });

  it("applies rate-limit response headers on a general (non-signup) route", async () => {
    const app = createApp(loadEnv(baseEnv));
    const res = await request(app).get("/healthz");
    // standardHeaders: true on the general limiter sets these on every
    // response, including 200s — used here just to prove the limiter is
    // actually mounted, not to exercise the limit itself.
    expect(res.headers["ratelimit-limit"]).toBeTruthy();
  });
});
