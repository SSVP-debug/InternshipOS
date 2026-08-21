// auth.ts
// The frontend's ONLY use of supabase-js: obtaining/refreshing the caller's
// own access token via Supabase Auth. No table in Postgres is ever read or
// written directly from the browser — every actual read/write goes through
// the Express API in api.ts, using the access_token this module exposes.
// That keeps exactly one enforcement path (RLS, behind the API's
// req.supabase), instead of two different code paths that could drift.

import { createClient, type Session } from "@supabase/supabase-js";

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();
let currentSession: Session | null = null;

supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  for (const listener of listeners) listener(session);
});

export function getSession(): Session | null {
  return currentSession;
}

export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function initSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;
  return currentSession;
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signIn(email: string, password: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
