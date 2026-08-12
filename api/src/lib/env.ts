// env.ts
// Central place that reads and validates the environment. Fails loudly and
// early (at import time) rather than letting an unset var surface later as
// a confusing runtime error deep in a request handler.
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  // service_role key: full DB access, bypasses RLS. Used ONLY by the signup
  // route's server-side auth-user creation call — never forwarded to a
  // client, never used for any per-candidate read/write (those always go
  // through a user-scoped client so RLS applies).
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  CONSENT_POLICY_VERSION: z.string().default("v1.0"),
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
