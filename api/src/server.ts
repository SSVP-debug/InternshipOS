// server.ts
// Phase 0 API surface:
//   Day 1: POST /signup (public); GET/POST /profile, GET/POST /consent (authenticated)
//   Day 2: GET/GET-one/POST/PUT/DELETE /education (authenticated) — Education entity
//          GET/POST/PUT /work-authorization (authenticated) — WorkAuthorization entity
//          GET/GET-one/POST/PUT/DELETE /skills (authenticated) — Skill entity
//          GET/GET-one/POST/PUT/DELETE /projects (authenticated) — Project entity
//          GET/GET-one/POST/PUT/DELETE /experiences (authenticated) — Experience entity
//          GET/GET-one/POST/PUT/DELETE /achievements (authenticated) — Achievement entity
//          GET/GET-one/POST/PUT/DELETE /certifications (authenticated) — Certification entity
//   Day 3: GET/GET-one/POST/PUT/DELETE /evidence-sources (authenticated) — EvidenceSource entity
//   Day 4: GET/GET-one/POST/PUT /claims, PATCH /claims/:id/status (authenticated)
//          — Claim entity. No DELETE route: claims are never deleted.
//   Day 5: GET /export (authenticated) — full JSON dump scoped to the caller
//          DELETE /account (authenticated) — real cascading account deletion
//   Day 6: GET /truth-center (authenticated) — derived read model over
//          Claim + EvidenceSource + the 7 candidate-fact tables. This is
//          the last piece of the Phase 0 "Candidate Truth Layer" as
//          originally scoped — nothing stored, no migration behind it.
// Nothing else from Day 7+ (matching, AI, resumes, applications, etc.) is
// wired in here.
//
// ── Engineering-foundation additions (this pass) ─────────────────────────
// GET  /healthz — liveness, no dependencies (see lib/health.ts)
// GET  /readyz  — readiness, checks Supabase reachability (see lib/health.ts)
// Security headers (helmet), CORS (opt-in via ALLOWED_ORIGINS), rate
// limiting (general + a tighter one on POST /signup), structured request
// logging with redaction, a centralized 404 + error handler, and graceful
// shutdown on SIGTERM/SIGINT. See docs/production-readiness.md for the
// operational rundown.

import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { loadEnv, type Env } from "./lib/env.js";
import { createLogger } from "./lib/logger.js";
import { checkReadiness } from "./lib/health.js";
import { requireAuth } from "./middleware/auth.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { generalRateLimiter, signupRateLimiter } from "./middleware/rateLimit.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { signupRouter } from "./routes/signup.js";
import { profileRouter } from "./routes/profile.js";
import { consentRouter } from "./routes/consent.js";
import { educationRouter } from "./routes/education.js";
import { workAuthorizationRouter } from "./routes/work-authorization.js";
import { skillRouter } from "./routes/skill.js";
import { projectRouter } from "./routes/project.js";
import { experienceRouter } from "./routes/experience.js";
import { achievementRouter } from "./routes/achievement.js";
import { certificationRouter } from "./routes/certification.js";
import { evidenceSourceRouter } from "./routes/evidence-source.js";
import { claimRouter } from "./routes/claim.js";
import { accountRouter } from "./routes/account.js";
import { truthCenterRouter } from "./routes/truth-center.js";

/**
 * Builds the Express app without starting a listener. Kept separate from
 * the bootstrap block below so it can be constructed in tests (e.g. with
 * supertest) without also binding a real port or wiring process signal
 * handlers.
 */
export function createApp(env: Env): Express {
  const logger = createLogger(env);
  const app = express();

  // Disables the `X-Powered-By: Express` response header (also covered by
  // helmet, but explicit here so it's not solely dependent on helmet's
  // current defaults).
  app.disable("x-powered-by");

  // Security headers: sane defaults (no COEP/CSP invented for an API with
  // no HTML responses — helmet's baseline HSTS/no-sniff/frameguard/etc.
  // headers are what actually apply here).
  app.use(helmet());

  // CORS is opt-in: with ALLOWED_ORIGINS unset, `origin` resolves to an
  // empty allowlist, so the cors middleware reflects no Access-Control-
  // Allow-Origin header and browsers block the response. Non-browser
  // callers (curl, server-to-server, the smoke test) are unaffected —
  // CORS is a browser-enforced boundary, not a network-level one.
  app.use(
    cors({
      origin: env.ALLOWED_ORIGINS.length > 0 ? env.ALLOWED_ORIGINS : false,
      credentials: true,
    })
  );

  // Structured request logging (method/url/status/duration/request id),
  // with the redaction rules from lib/logger.ts applied to every line.
  // Mounted before body parsing / routes so every request — including
  // ones that fail body parsing — gets logged.
  app.use(requestLogger(logger));

  app.use(generalRateLimiter(env));

  app.use(express.json());

  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    const result = await checkReadiness(env);
    res.status(result.ready ? 200 : 503).json(result);
  });

  app.use(signupRateLimiter(env), signupRouter(env));
  // NOTE (documented, not changed — see docs/production-readiness.md
  // "Known behavior: auth precedes routing"): requireAuth() is mounted as
  // blanket middleware ahead of every router below. With no Authorization
  // header, the first requireAuth in this chain returns 401 immediately,
  // before any router gets a chance to evaluate whether the path even
  // exists — so an anonymous request to an unknown path under this stack
  // gets 401, not 404. This is pre-existing, working authentication
  // behavior (arguably a reasonable fail-closed default: it doesn't leak
  // which paths exist to unauthenticated callers) and is intentionally
  // left as-is rather than restructured, per this pass's scope.
  app.use(requireAuth(env), profileRouter());
  app.use(requireAuth(env), consentRouter(env));
  app.use(requireAuth(env), educationRouter());
  app.use(requireAuth(env), workAuthorizationRouter());
  app.use(requireAuth(env), skillRouter());
  app.use(requireAuth(env), projectRouter());
  app.use(requireAuth(env), experienceRouter());
  app.use(requireAuth(env), achievementRouter());
  app.use(requireAuth(env), certificationRouter());
  app.use(requireAuth(env), evidenceSourceRouter());
  app.use(requireAuth(env), claimRouter());
  app.use(requireAuth(env), accountRouter(env));
  app.use(requireAuth(env), truthCenterRouter());

  // Must be last: unmatched routes, then the catch-all error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// ── Bootstrap (only runs when this file is executed directly, i.e. `npm
// run dev` / `npm start` — not when createApp is imported by a test) ────

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = createApp(env);

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, "InternshipOS API listening");
  });

  // Fail loudly on the two crash classes Node doesn't handle for you.
  // Logging then exiting (rather than trying to keep serving on
  // undefined state) is deliberate — an orchestrator (Render) restarts
  // the process, which is safer than continuing after a crash whose
  // blast radius is unknown.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught_exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled_rejection");
    process.exit(1);
  });

  // Graceful shutdown: stop accepting new connections, let in-flight
  // requests finish, then exit. Render (and most orchestrators) send
  // SIGTERM before a hard kill on deploys/restarts.
  function shutdown(signal: string): void {
    logger.info({ signal }, "shutting_down");
    server.close((err) => {
      if (err) {
        logger.error({ err }, "error_during_shutdown");
        process.exit(1);
      }
      logger.info("shutdown_complete");
      process.exit(0);
    });
    // Safety valve: if something keeps an in-flight request open
    // indefinitely, don't hang forever — force-exit after a grace period.
    setTimeout(() => {
      logger.error("shutdown_timed_out_forcing_exit");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
