// requestLogger.ts
// Attaches a per-request id (reused from an inbound X-Request-Id header
// when present, e.g. set by Render's edge or a load balancer, otherwise
// generated) and a structured request/response log line via pino-http.
//
// This is the ONLY place request/response objects are logged. It uses
// pino-http's default req/res serializers (method, url, status, response
// time — not headers or bodies) combined with the redaction list in
// logger.ts, so an Authorization header or request body containing PII
// (personal_info, evidence content, etc.) never reaches a log line by
// construction, not by remembering to scrub it at every call site.

import { randomUUID } from "node:crypto";
import { pinoHttp as pinoHttpFactory } from "pino-http";
import type { Request, Response } from "express";
import type { Logger } from "../lib/logger.js";

export function requestLogger(logger: Logger) {
  return pinoHttpFactory({
    logger,
    genReqId: (req: Request, res: Response) => {
      const existing = req.headers["x-request-id"];
      const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    // Never log request/response bodies (personal_info, claim text,
    // evidence references, credentials) — only method/url/status/timing,
    // which is what pino-http logs by default when no custom serializers
    // are supplied for req.body/res.body (we don't add any).
    customLogLevel: (_req: Request, res: Response, err?: Error) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  });
}

// Small helper so route handlers/tests can pull a per-request logger
// without importing pino-http's types directly.
export function reqLogger(req: Request): Logger {
  return (req as unknown as { log: Logger }).log;
}
