// errorHandler.ts
// Two pieces of centralized failure handling that the API previously
// lacked:
//
//   1. notFoundHandler — a predictable 404 JSON body for any request that
//      doesn't match a route, instead of Express's default HTML 404 page.
//
//   2. errorHandler — a last-resort Express error-handling middleware
//      (four-arg signature, must be registered last). Every route in this
//      API already catches its own Supabase errors and returns a JSON
//      response, so in normal operation this should rarely fire — it
//      exists for the cases those routes don't cover: a thrown exception,
//      a rejected promise passed to next(err) (or one that escapes an
//      async handler entirely — see note below), or a body-parser
//      failure (malformed JSON) upstream of any route.
//
// This handler NEVER sends a stack trace, error class name, or raw
// driver/Postgres error object to the client. It logs the full error
// server-side (via the per-request logger attached by requestLogger.ts)
// and returns a stable, generic JSON error to the caller.
//
// NOTE on async route handlers: Express 4 does not automatically forward
// a rejected promise from an `async (req, res) => {...}` handler to this
// error handler — a handler that throws after an `await` without its own
// try/catch will crash the process instead of reaching here. Every route
// in this codebase currently guards its own Supabase calls with
// destructured `{ data, error }` results (not exceptions), which sidesteps
// this gap for the known code paths today. It's flagged here rather than
// silently relied upon: any new async route handler added later that can
// throw (e.g. `JSON.parse` on a field, a thrown validation error) needs
// either its own try/catch or a wrapper like `express-async-errors269`.
// Not installed here — it's a broader pattern change than this pass's
// "small, isolated, additive" scope allows; documented instead.

import type { NextFunction, Request, Response } from "express";

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "not_found", path: req.path });
}

// Express identifies error-handling middleware by arity (4 params) —
// `next` must stay in the signature; it's only invoked in the
// already-streaming edge case below.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const logger = (req as unknown as { log?: { error: (obj: unknown, msg?: string) => void } }).log;
  const message = err instanceof Error ? err.message : "unknown_error";

  if (logger) {
    logger.error({ err }, "unhandled_request_error");
  } else {
    // Fallback only reachable if requestLogger.ts's middleware somehow
    // isn't mounted ahead of this (e.g. a future test wiring). Never the
    // path in the real app — server.ts mounts requestLogger before any
    // route.
    // eslint-disable-next-line no-console
    console.error("unhandled_request_error", message);
  }

  if (res.headersSent) {
    // Response already started (e.g. streaming) — delegate to Express's
    // default handler, which closes the connection; sending our own body
    // here would produce a malformed response.
    next(err);
    return;
  }

  res.status(500).json({ error: "internal_server_error" });
}
