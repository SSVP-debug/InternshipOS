// env.ts
// Central place that reads and validates the environment. Fails loudly and
// early (at import time) rather than letting an unset var surface later as
// a confusing runtime error deep in a request handler.
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  // service_role key: full DB access, bypasses RLS. Used only by two
  // routes: signup's server-side auth-user creation (POST /signup) and
  // account deletion's server-side auth-user removal (DELETE /account) —
  // both are operations on auth.users itself, which the anon-key
  // user-scoped client cannot perform. Never forwarded to a client, never
  // used for any per-candidate read/write (those always go through a
  // user-scoped client so RLS applies).
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  CONSENT_POLICY_VERSION: z.string().default("v1.0"),

  // Controls logger.ts's pino transport (pretty-printed outside
  // production) and log level default. "test" behaves like "development"
  // everywhere except vitest sets it automatically via its own env
  // handling — not asserted on here, just accepted as a valid value.
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // CORS allowlist for server.ts's createApp(): comma-separated list of
  // exact origins (e.g. "https://app.example.com,https://staging.example.com").
  // Unset means no cross-origin requests are allowed at all — never
  // reflected as a wildcard. Parsed once in server.ts, not here, to keep
  // this schema's output plain strings (same convention as every other
  // field) rather than a pre-split array.
  ALLOWED_ORIGINS: z.string().optional(),

  // Shared window for both rate limiters below (rateLimit.ts). Kept as one
  // value rather than a separate window per limiter — this repo has never
  // needed two different windows, and a single knob is one fewer thing to
  // misconfigure.
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  // POST /signup's tighter limiter (rateLimit.ts's signupRateLimiter) —
  // see that file's header comment for why signup specifically gets its
  // own, stricter limit.
  SIGNUP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  // Gate R8 — kill switch for POST /applications/:id/submit-to-ats
  // (api/src/lib/ats/leverAdapter.ts). Off by default: this route sends a
  // real application to a real employer on the candidate's behalf, unlike
  // every other route in this codebase, which only ever touches this
  // candidate's own tracking data. Defaulting to false means a fresh
  // deploy (or a forgotten env var) never accidentally exposes live
  // external submission. Per-request dry_run defaults still apply on top
  // of this flag — see that route's own comment for the two-layer
  // reasoning.
  //
  // Deliberately NOT z.coerce.boolean(): zod's coercion runs the string
  // through JS's Boolean(), where Boolean("false") is true — setting
  // EXTERNAL_ATS_SUBMISSION_ENABLED=false in an env file would silently
  // turn the flag ON under z.coerce.boolean(). An explicit string enum +
  // transform avoids that trap entirely.
  EXTERNAL_ATS_SUBMISSION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid/missing environment variables:\n${issues}`);
  }
  return parsed.data;
}
