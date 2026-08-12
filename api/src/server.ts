// server.ts
// Phase 0 / Day 1 API surface only:
//   POST /signup   (public)
//   GET  /profile  (authenticated)
//   POST /profile  (authenticated)
//   GET  /consent  (authenticated)
//   POST /consent  (authenticated)
// Nothing from Day 2+ (evidence, claims, matching, etc.) is wired in here.

import express from "express";
import { loadEnv } from "./lib/env.js";
import { requireAuth } from "./middleware/auth.js";
import { signupRouter } from "./routes/signup.js";
import { profileRouter } from "./routes/profile.js";
import { consentRouter } from "./routes/consent.js";

const env = loadEnv();
const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

app.use(signupRouter(env));
app.use(requireAuth(env), profileRouter());
app.use(requireAuth(env), consentRouter(env));

app.listen(env.PORT, () => {
  console.log(`InternshipOS API (Day 1) listening on :${env.PORT}`);
});
