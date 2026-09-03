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
//   Phase 1 (InternshipOS product loop, on top of the Candidate Truth
//          Layer foundation above — see docs/decisions-log.md D-003+):
//     GET /today — the daily dashboard (lib/todayView.ts)
//     GET/GET-one/POST/PUT/PATCH-inbox/DELETE /opportunities — Opportunity
//          entity (candidate-owned, manual/import-based discovery)
//     GET/GET-one/POST/PUT/PATCH-status /applications — Application entity
//          with the SAVED..WITHDRAWN lifecycle
//     GET/POST /applications/:applicationId/notes,
//     PUT/DELETE /application-notes/:id — lightweight application notes
//   Phase 2B (personalized opportunity feed, read/aggregation layer over
//          opportunity_source + opportunity_match — see
//          lib/opportunityFeed.ts):
//     GET /opportunity-feed — the candidate's own opportunity_match rows
//          joined to active opportunity_source rows
//     PATCH /opportunity-matches/:id/inbox — save/dismiss/priority on a
//          match, mirrors PATCH /opportunities/:id/inbox
//     POST /opportunity-matches/bulk-apply — Gate R5, turns 1–20 selected
//          matches into applications in one call (see opportunity-feed.ts)
//   Gate R1/R7 (resumes — a candidate's role-specific skill groupings,
//          see docs/gate-r0-resume-design.md):
//     GET/GET-one/POST/PUT /resumes — Resume entity. No DELETE route —
//          archiving (PUT is_active:false) is the only removal mechanism.
//     POST /resumes/:id/skills, DELETE /resumes/:id/skills/:skillId —
//          attach/detach an existing skill to/from a resume.
// Nothing else from Day 7+ / Phase 2+ (matching, AI generation,
// recruiter-facing features, etc.) is wired in here.

import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { pathToFileURL } from "node:url";
import { loadEnv, type Env } from "./lib/env.js";
import { createLogger } from "./lib/logger.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { generalRateLimiter, signupRateLimiter } from "./middleware/rateLimit.js";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { checkReadiness } from "./lib/health.js";
import { requireAuth } from "./middleware/auth.js";
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
import { todayRouter } from "./routes/today.js";
import { opportunityRouter } from "./routes/opportunity.js";
import { opportunityFeedRouter } from "./routes/opportunity-feed.js";
import { applicationRouter } from "./routes/application.js";
import { applicationNoteRouter } from "./routes/application-note.js";
import { resumeRouter } from "./routes/resume.js";

// Builds the Express app for a given Env, without starting a listener —
// so tests (see tests/app.test.ts) can construct as many independent app
// instances as they need against a real HTTP layer (via supertest) without
// ever binding a real port. The bottom of this file calls this and starts
// listening, but only when server.ts is actually run as the process
// entrypoint (see the isMainModule guard) — never as a side effect of
// merely importing this module, which every test file that imports
// createApp would otherwise trigger.
export function createApp(env: Env): Express {
  const logger = createLogger(env);
  const app = express();

  // Security headers (nosniff, hidden X-Powered-By, etc.) — first, so
  // every response gets them regardless of what happens downstream.
  app.use(helmet());

  // CORS: an explicit allowlist only (ALLOWED_ORIGINS, comma-separated).
  // Unset means no origin is ever reflected — never falls back to "*" or
  // to any hardcoded default, since this is what's actually deployed
  // behind, and getting it wrong in either direction is a real security
  // property, not a convenience default.
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, false); // no Origin header — nothing to reflect
        callback(null, allowedOrigins.includes(origin));
      },
    })
  );

  // Per-request id + structured request/response logging — mounted early
  // so req.log exists for every downstream handler, including
  // errorHandler at the bottom of the stack.
  app.use(requestLogger(logger));

  // Defense-in-depth request-flooding limit, applied to every route
  // (including /healthz — see rateLimit.ts's own header comment on why
  // this is intentionally generous, not a correctness gap).
  app.use(generalRateLimiter(env));

  app.use(express.json());

  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/readyz", async (_req, res) => {
    const result = await checkReadiness(env);
    res.status(result.ready ? 200 : 503).json(result);
  });

  // POST /signup is the one unauthenticated route capable of creating a
  // resource — gets its own, tighter limiter on top of the general one
  // above (see rateLimit.ts's header comment). Scoped to the /signup path
  // specifically (not app.use(limiter, router) unscoped) so this stricter
  // limit only ever applies to signup traffic, never to every unmatched
  // request that happens to fall through to this point in the stack.
  app.use("/signup", signupRateLimiter(env));
  app.use(signupRouter(env));

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
  app.use(requireAuth(env), todayRouter());
  app.use(requireAuth(env), opportunityRouter());
  app.use(requireAuth(env), opportunityFeedRouter());
  app.use(requireAuth(env), applicationRouter());
  app.use(requireAuth(env), applicationNoteRouter());
  app.use(requireAuth(env), resumeRouter());

  // Must be last: notFoundHandler catches anything no router matched;
  // errorHandler is Express's four-arg error middleware, only reachable
  // via next(err) or a thrown/rejected error from an above handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const env = loadEnv();
  const app = createApp(env);
  app.listen(env.PORT, () => {
    console.log(`InternshipOS API listening on :${env.PORT}`);
  });
}
