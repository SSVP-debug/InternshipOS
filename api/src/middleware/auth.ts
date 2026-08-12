// auth.ts
// Extracts the caller's access token from the Authorization header and
// attaches a per-request, user-scoped Supabase client (see supabaseClient.ts)
// to req. Does NOT itself decide what the user can access — that's RLS's
// job. This middleware's only responsibility is "no token, no request."

import type { Request, Response, NextFunction } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userScopedClient } from "../lib/supabaseClient.js";
import type { Env } from "../lib/env.js";

export interface AuthedRequest extends Request {
  supabase?: SupabaseClient;
  accessToken?: string;
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function requireAuth(env: Env) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.header("authorization"));
    if (!token) {
      return res.status(401).json({ error: "missing_or_invalid_authorization_header" });
    }
    req.accessToken = token;
    req.supabase = userScopedClient(env, token);
    next();
  };
}
