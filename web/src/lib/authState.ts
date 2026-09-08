// authState.ts
//
// Deliberately its own tiny, dependency-free module — no supabase-js
// import, no `import.meta.env` read, nothing that runs on import. auth.ts
// can't hold this function itself because importing auth.ts anywhere
// (including from a test file) executes `createClient(...)` at module
// load time, which throws ("supabaseUrl is required.") unless real
// VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY env vars are present — fine in
// the built app, but not something a plain unit test should have to set
// up just to check a boolean comparison. Same "logic separated from I/O
// for testability" discipline the backend already follows in
// matchEngine.ts / todayView.ts.

/**
 * True only when authentication status actually flipped (logged-out →
 * logged-in, or vice versa) — not for every Supabase auth event.
 *
 * Gate A1: main.ts used to force a full route re-render on every single
 * onSessionChange callback, including events like TOKEN_REFRESHED (fired
 * automatically roughly once an hour while a tab stays open) where the
 * session is non-null both before and after — nothing a route guard
 * (requireAuth/requireGuest in main.ts) actually cares about changed. A
 * forced re-render meant the whole current page was silently torn down
 * and its data re-fetched from scratch, invisibly, in the background of
 * whatever the person was doing. Only a genuine transition needs the
 * router to re-evaluate its guards.
 */
export function authStateTransitioned(wasAuthenticated: boolean, isAuthenticated: boolean): boolean {
  return wasAuthenticated !== isAuthenticated;
}
