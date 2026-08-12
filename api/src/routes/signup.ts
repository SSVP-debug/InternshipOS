// signup.ts
// POST /signup
//
// This is the ONLY route in Phase 0 that uses the admin (service_role)
// client, and it uses it for exactly one thing: creating the auth.users
// row via Supabase's Auth admin API. The matching public.candidate row is
// created automatically by the 0006_signup_provisioning.sql trigger — this
// route does not touch the candidate table directly.

import { Router } from "express";
import type { Env } from "../lib/env.js";
import { SignupRequestSchema } from "../lib/schemas.js";
import { adminClient } from "../lib/supabaseClient.js";

export function signupRouter(env: Env): Router {
  const router = Router();

  router.post("/signup", async (req, res) => {
    const parsed = SignupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const { email, password } = parsed.data;
    const supabase = adminClient(env);

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false, // real email confirmation flow is a Day 2+ concern
    });

    if (error) {
      // Do not leak internal error detail to the client beyond a stable code.
      return res.status(400).json({ error: "signup_failed", message: error.message });
    }

    return res.status(201).json({
      user_id: data.user?.id,
      message: "Account created. A candidate profile has been provisioned automatically.",
    });
  });

  return router;
}
