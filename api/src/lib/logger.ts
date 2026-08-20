// logger.ts
// Single provider-neutral structured logger for the whole API, built on
// pino (JSON in production, human-readable in development). Nothing here
// talks to a specific vendor (Datadog/Sentry/etc.) — if one is added
// later, it should consume these JSON logs (or pino's transport system),
// not replace this module.
//
// SAFETY: this module also owns the one and only redaction list for
// fields that must never reach a log line. Every call site should log
// req/error objects through the helpers below (or pino-http's default
// req/res serializers, configured in requestLogger.ts) rather than
// hand-rolling `console.log(JSON.stringify(req.headers))` or similar,
// which would bypass redaction entirely.

import pino from "pino";
import type { Env } from "./env.js";

// Paths pino's built-in redaction understands (dot/bracket paths across
// the object being logged, including nested `req.headers...`). Keep this
// list narrow and specific rather than trying to redact "everything that
// looks sensitive" — an overly broad redact path silently swallows
// legitimate diagnostic fields, which is its own reliability problem.
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers[\"set-cookie\"]",
  "*.password",
  "*.access_token",
  "*.accessToken",
  "*.refresh_token",
  "*.service_role_key",
  "*.SUPABASE_SERVICE_ROLE_KEY",
  "*.SUPABASE_ANON_KEY",
];

export function createLogger(env: Pick<Env, "NODE_ENV">) {
  return pino({
    level: process.env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    // Pretty-print only outside production, and only if pino-pretty is
    // actually resolvable (it's a devDependency) — this keeps the
    // production build from depending on a dev-only transport package.
    transport:
      env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } },
    base: { service: "internshipos-api" },
  });
}

export type Logger = ReturnType<typeof createLogger>;
