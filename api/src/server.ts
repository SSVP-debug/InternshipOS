// server.ts
// Phase 0 API surface:
//   Day 1: POST /signup (public); GET/POST /profile, GET/POST /consent (authenticated)
//   Day 2: GET/GET-one/POST/PUT/DELETE /education (authenticated) — Education entity
//          GET/POST/PUT /work-authorization (authenticated) — WorkAuthorization entity
// Nothing else from Day 2+ (Skills, Projects, Experience, Achievements,
// Certifications, evidence, claims, matching, AI, etc.) is wired in here.

import express from "express";
import { loadEnv } from "./lib/env.js";
import { requireAuth } from "./middleware/auth.js";
import { signupRouter } from "./routes/signup.js";
import { profileRouter } from "./routes/profile.js";
import { consentRouter } from "./routes/consent.js";
import { educationRouter } from "./routes/education.js";
import { workAuthorizationRouter } from "./routes/work-authorization.js";

const env = loadEnv();
const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

app.use(signupRouter(env));
app.use(requireAuth(env), profileRouter());
app.use(requireAuth(env), consentRouter(env));
app.use(requireAuth(env), educationRouter());
app.use(requireAuth(env), workAuthorizationRouter());

app.listen(env.PORT, () => {
  console.log(`InternshipOS API listening on :${env.PORT}`);
});
