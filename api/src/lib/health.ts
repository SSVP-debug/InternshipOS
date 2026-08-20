// health.ts
// Backing logic for the two health endpoints wired up in server.ts:
//
//   GET /healthz  — liveness. Answers "is the process up and able to
//                   handle HTTP at all?" with no dependency checks. Must
//                   stay fast and dependency-free — this is what an
//                   orchestrator/host (Render) polls to decide whether to
//                   keep routing traffic to / restart this instance.
//
//   GET /readyz   — readiness. Answers "can this instance actually serve
//                   real requests?" by making one cheap round-trip to
//                   Supabase (via the anon key, unauthenticated — the
//                   same PostgREST root endpoint the keepalive workflow
//                   already pings, see .github/workflows/supabase-
//                   keepalive.yml) and reporting 200 only if that
//                   succeeds. Does not accept or need a per-request JWT.
//
// Neither endpoint returns any environment/config value (no URLs, no key
// fragments, no version strings tied to internals) — only a boolean-ish
// status, so a public, unauthenticated health endpoint can't be used to
// fingerprint the deployment.

import type { Env } from "./env.js";

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: "ok" | "unreachable";
  };
}

export async function checkReadiness(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">): Promise<ReadinessResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // PostgREST root returns 200 when reachable; anything below 500
    // still means "the project answered", which is what readiness cares
    // about here (matches the keepalive workflow's own success check).
    const ok = res.status < 500;
    return { ready: ok, checks: { database: ok ? "ok" : "unreachable" } };
  } catch {
    return { ready: false, checks: { database: "unreachable" } };
  }
}
