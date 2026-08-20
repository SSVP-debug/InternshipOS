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
  // "development" | "test" | "production" — never inferred from anything
  // else. Used only to (a) choose log formatting (pretty vs JSON) and
  // (b) decide whether missing ALLOWED_ORIGINS should be a hard failure.
  // Defaulting to "development" is deliberate: it's the safest default to
  // fail *open* on convenience and *closed* on anything security-relevant
  // (CORS below still defaults to "no cross-origin access" regardless of
  // NODE_ENV), so an operator who forgets to set NODE_ENV in production
  // does not silently get production credentials treated as dev ones —
  // there are no environment-specific credentials in this schema; every
  // secret above is always required, in every environment, with no
  // fallback value, so there is no "accidental prod-uses-dev-secret" path
  // to begin with.
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Comma-separated list of allowed browser origins for CORS, e.g.
  // "https://app.internshipos.example,https://staging.internshipos.example".
  // Deliberately opt-in and unset by default: with no value, the API
  // still works for non-browser callers (curl, server-to-server, the
  // smoke test) — Authorization-header requests from those never go
  // through browser CORS preflight — but no browser page on any origin
  // can call it with credentials. Set this explicitly for whatever
  // origin(s) the actual frontend is served from.
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((o) => o.trim()).filter(Boolean) : [])),
  // Sets the ceiling for POST /signup (the one unauthenticated,
  // account-creation-capable route) to blunt automated signup/enumeration
  // abuse. Requests per IP per RATE_LIMIT_WINDOW_MINUTES.
  SIGNUP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
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
