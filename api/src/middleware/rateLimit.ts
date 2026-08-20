// rateLimit.ts
// In-process (single-instance) rate limiting via express-rate-limit.
//
// SCOPE NOTE: this is deliberately in-memory, not Redis-backed. The
// current deployment model (single Render web service, no horizontal
// scaling configured — see docs/production-readiness.md) has exactly one
// process, so an in-memory store is not a correctness gap today. If/when
// this API runs as more than one instance, this store needs to move to a
// shared backend (Redis, etc.) or the limit becomes per-instance instead
// of global — that infrastructure does not exist in this repo yet and is
// not invented here; documented instead, per the "don't build expensive
// infra the deployment doesn't need yet" instruction.
//
// Only POST /signup gets a dedicated, tighter limiter: it is the one
// unauthenticated route capable of creating a resource (an auth.users
// row), making it the obvious target for automated abuse (mass account
// creation, email enumeration via error-message timing/content). Every
// other route already requires a valid Supabase JWT, which itself costs
// an attacker a successful signup + login to obtain — a much higher bar
// than an anonymous POST.
//
// A light general limiter is also applied API-wide as defense-in-depth
// against basic request flooding; it is intentionally generous so it
// does not interfere with legitimate use.

import rateLimit from "express-rate-limit";
import type { Env } from "../lib/env.js";

export function generalRateLimiter(env: Pick<Env, "RATE_LIMIT_WINDOW_MINUTES">) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited" },
  });
}

export function signupRateLimiter(env: Pick<Env, "SIGNUP_RATE_LIMIT_MAX" | "RATE_LIMIT_WINDOW_MINUTES">) {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: env.SIGNUP_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limited", detail: "too many signup attempts, try again later" },
  });
}
