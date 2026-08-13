// server.ts
// Phase 0 API surface:
//   Day 1: POST /signup (public); GET/POST /profile, GET/POST /consent (authenticated)
//   Day 2: GET/GET-one/POST/PUT/DELETE /education (authenticated) — Education entity
//          GET/POST/PUT /work-authorization (authenticated) — WorkAuthorization entity
//          GET/GET-one/POST/PUT/DELETE /skills (authenticated) — Skill entity
//          GET/GET-one/POST/PUT/DELETE /projects (authenticated) — Project entity
//          GET/GET-one/POST/PUT/DELETE /experiences (authenticated) — Experience entity
//          GET/GET-one/POST/PUT/DELETE /achievements (authenticated) — Achievement entity
// Nothing else from Day 2+ (Certifications, evidence, claims, matching,
// AI, resumes, applications, etc.) is wired in here.

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

app.listen(env.PORT, () => {
  console.log(`InternshipOS API listening on :${env.PORT}`);
});
