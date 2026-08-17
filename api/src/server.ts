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
// Nothing else from Day 6+ (Truth Center, matching, AI, resumes,
// applications, etc.) is wired in here.

import express from "express";
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

const env = loadEnv();
const app = express();
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

app.listen(env.PORT, () => {
  console.log(`InternshipOS API listening on :${env.PORT}`);
});
