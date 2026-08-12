// supabaseClient.ts
//
// Two, and only two, ways to talk to Supabase from this API:
//
// 1. adminClient(env) — service_role key, bypasses RLS. Used ONLY for the
//    signup route's call to the Auth admin API (creating the auth.users
//    row). Never used to read/write candidate/personal_info/consent_record
//    tables directly — that would defeat the entire RLS boundary.
//
// 2. userScopedClient(env, accessToken) — anon key + the requesting user's
//    own JWT attached as the Authorization header. Every candidate-data
//    read/write in this API goes through this client, so Postgres RLS (not
//    application code) is what actually enforces ownership.
//
// This split is the Day-1 "security boundary" requirement expressed in
// code, not just in the database.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

export function adminClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function userScopedClient(env: Env, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}
