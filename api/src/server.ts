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
// Nothing else from Day 7+ / Phase 2+ (matching, AI generation, resumes,
// recruiter-facing features, etc.) is wired in here.

import express from "express";
import cors from "cors";
import { loadEnv } from "./lib/env.js";
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
import { applicationRouter } from "./routes/application.js";
import { applicationNoteRouter } from "./routes/application-note.js";

const env = loadEnv();
const app = express();
app.use(
  cors({
    origin: "http://localhost:5173",
  })
);
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

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
app.use(requireAuth(env), applicationRouter());
app.use(requireAuth(env), applicationNoteRouter());

app.listen(env.PORT, () => {
  console.log(`InternshipOS API listening on :${env.PORT}`);
});
