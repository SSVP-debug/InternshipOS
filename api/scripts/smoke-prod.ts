// smoke-prod.ts
//
// Production smoke test for InternshipOS. Run with: npm run smoke:prod
//
// WHAT THIS DOES: creates one disposable candidate account against the real
// deployed API and real production Supabase, exercises the core Phase-0
// flow (signup -> auth -> profile -> consent -> a representative CRUD
// entity -> export -> truth center -> ownership isolation), then deletes
// everything it created. Nothing here is application code — this is a
// standalone operator/CI verification tool, kept deliberately outside
// src/ so it can never accidentally become a request-serving code path.
//
// SECURITY BOUNDARIES (do not weaken these):
//   - This script NEVER reads or requires SUPABASE_SERVICE_ROLE_KEY. It
//     authenticates exactly like a real candidate would: SUPABASE_URL +
//     SUPABASE_ANON_KEY to sign in, then a Bearer access token on every
//     authenticated API call. If it can't get a token, it can't clean up
//     via the API — see the "cannot authenticate" path below, which
//     reports the orphaned user id instead of inventing a workaround.
//   - Every created record is deleted by the same account that created
//     it, through the public API, the same way a real user would delete
//     their own data. No cross-account, no admin-path shortcuts.
//   - No password, access token, anon key, or Authorization header is
//     ever printed. sanitize() is a defense-in-depth pass over any text
//     before it's logged.
//
// SAFETY GATE: refuses to run unless the target looks like production
// (or SMOKE_TEST_MODE=true is set for local development of this script
// itself) AND SMOKE_PROD_CONFIRM=true is set. See checkSafety() below.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomInt } from "node:crypto";

// ── Configuration ──────────────────────────────────────────────────────

const API_URL = (process.env.SMOKE_API_URL || "https://internshipos-api.onrender.com").replace(/\/$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROD_CONFIRM = process.env.SMOKE_PROD_CONFIRM === "true";
const TEST_MODE = process.env.SMOKE_TEST_MODE === "true";

// ── Safety gate ────────────────────────────────────────────────────────
// This must run and pass before anything else, including before we even
// construct a Supabase client — refusing early is the whole point.

function looksLocal(url: string): boolean {
  return /localhost|127\.0\.0\.1/i.test(url);
}

function checkSafety(): void {
  console.log("InternshipOS Production Smoke Test");
  console.log(`Target: ${API_URL}`);

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error(
      "\nMissing required environment variables. This script needs:\n" +
        "  SUPABASE_URL         (production Supabase project URL)\n" +
        "  SUPABASE_ANON_KEY    (production anon/publishable key)\n" +
        "It must NOT be given SUPABASE_SERVICE_ROLE_KEY, and does not read it.\n"
    );
    process.exit(1);
  }

  if (!TEST_MODE && (looksLocal(API_URL) || looksLocal(SUPABASE_URL))) {
    console.error(
      "\nRefusing to run: SMOKE_API_URL or SUPABASE_URL looks like a local " +
        "address, not production. If this is deliberate (developing this " +
        "script itself against a local stack), set SMOKE_TEST_MODE=true.\n"
    );
    process.exit(1);
  }

  if (!PROD_CONFIRM) {
    console.error(
      "\nThis script creates and deletes a real account against the target " +
        "above. Set SMOKE_PROD_CONFIRM=true to proceed.\n" +
        "Example (PowerShell):\n" +
        '  $env:SMOKE_PROD_CONFIRM="true"; npm run smoke:prod\n' +
        "Example (bash):\n" +
        "  SMOKE_PROD_CONFIRM=true npm run smoke:prod\n"
    );
    process.exit(1);
  }
}

// ── Output sanitization ───────────────────────────────────────────────
// Defense in depth: even though we never intentionally print a token,
// strip anything JWT-shaped from any text before it reaches console.log.

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function sanitize(text: string): string {
  return text.replace(JWT_PATTERN, "[redacted-token]");
}

// ── Disposable password generation ────────────────────────────────────
// Never logged. Satisfies SignupRequestSchema's min-8-char rule with a
// wide margin, and includes upper/lower/digit/symbol so it also clears
// typical Supabase Auth password-strength policies without needing to
// know the exact policy in advance.

function generatePassword(): string {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+";
  const all = lower + upper + digits + symbols;
  const pick = (charset: string) => charset[randomInt(charset.length)];

  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols), ...Array.from({ length: 16 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ── Minimal API client ────────────────────────────────────────────────

interface ApiResult<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  body: T;
}

async function apiCall<T = Record<string, unknown>>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, ok: res.ok, body: (body ?? {}) as T };
}

// ── Checklist tracking ────────────────────────────────────────────────

interface CheckOutcome {
  name: string;
  passed: boolean;
  detail?: string;
}
const results: CheckOutcome[] = [];

function record(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, detail });
  const line = passed ? `✓ ${name}` : `✗ ${name}${detail ? ` — ${sanitize(detail)}` : ""}`;
  console.log(line);
}

function assert(condition: boolean, failureDetail: string): void {
  if (!condition) throw new Error(failureDetail);
}

// ── Smoke-test entities ───────────────────────────────────────────────

interface SmokeUser {
  email: string;
  password: string;
  userId: string;
  accessToken: string;
}

function newSmokeEmail(): string {
  return `internshipos-smoke-${Date.now()}-${randomInt(1000, 9999)}@example.com`;
}

// ── Main flow ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  checkSafety();

  // Only used for signing in (never for direct table access — that would
  // require the service-role key, which this script deliberately never
  // touches). Every authenticated API call below goes through fetch()
  // with a Bearer token, exactly like a real client.
  const authClient: SupabaseClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let primaryUser: SmokeUser | null = null;
  let overallFailure = false;

  try {
    // 1. Health -----------------------------------------------------------
    try {
      const health = await apiCall<{ status?: string }>("GET", "/healthz");
      assert(health.status === 200 && health.body.status === "ok", `expected 200 {status:"ok"}, got ${health.status} ${JSON.stringify(health.body)}`);
      record("healthz", true);
    } catch (err) {
      record("healthz", false, (err as Error).message);
      throw new Error("aborting — API is not healthy, nothing else can be trusted");
    }

    // 2 & 3. Signup + candidate provisioning -------------------------------
    const email = newSmokeEmail();
    const password = generatePassword();
    let userId: string | undefined;
    let signupMessage = "";
    try {
      const signup = await apiCall<{ user_id?: string; message?: string }>("POST", "/signup", {
        body: { email, password },
      });
      assert(signup.status === 201, `expected 201, got ${signup.status} ${JSON.stringify(signup.body)}`);
      assert(typeof signup.body.user_id === "string" && signup.body.user_id.length > 0, "response missing user_id");
      userId = signup.body.user_id;
      signupMessage = signup.body.message ?? "";
      record("signup", true);
    } catch (err) {
      record("signup", false, (err as Error).message);
      throw new Error("aborting — signup failed, no account was created to clean up");
    }

    try {
      assert(
        /candidate/i.test(signupMessage) && /provision/i.test(signupMessage),
        `signup response did not confirm candidate provisioning: "${signupMessage}"`
      );
      record("candidate provisioning", true);
    } catch (err) {
      // Non-fatal here — the authoritative check is the profile read below.
      // A wording change in the signup message shouldn't itself fail the
      // whole run if the candidate row genuinely exists.
      record("candidate provisioning", false, (err as Error).message);
    }

    // From here on, a created auth user exists in production. If anything
    // below throws, the outer finally block still attempts cleanup — but
    // only once we actually have an access token (see cleanup section).

    // 4. Authentication -----------------------------------------------------
    let accessToken: string | undefined;
    try {
      const { data, error } = await authClient.auth.signInWithPassword({ email, password });
      if (error) {
        const isEmailConfirmationIssue =
          (error as { code?: string }).code === "email_not_confirmed" || /email not confirmed/i.test(error.message);
        if (isEmailConfirmationIssue) {
          record(
            "authentication",
            false,
            "production requires email confirmation before password sign-in — this is an environment " +
              "prerequisite, not a bug. No code change should be made to bypass this."
          );
          console.error(
            `\nPREREQUISITE FAILURE: could not authenticate the smoke-test account because email ` +
              `confirmation is required.\n` +
              `Created auth user id: ${userId}\n` +
              `This user could NOT be cleaned up automatically — this script never uses the ` +
              `service-role key, so it cannot delete an account it can't authenticate as.\n` +
              `Manual cleanup required: delete this user from the Supabase dashboard ` +
              `(Authentication -> Users) or via a separately-run, deliberately-invoked admin script.\n`
          );
        } else {
          record("authentication", false, error.message);
          console.error(
            `\nAuthentication failed for a reason other than email confirmation.\n` +
              `Created auth user id: ${userId}\n` +
              `This user could NOT be cleaned up automatically for the same reason as above ` +
              `(no token, and this script will not use the service-role key to force it).\n` +
              `Manual cleanup required via the Supabase dashboard.\n`
          );
        }
        throw new Error("cannot proceed without an authenticated session");
      }
      assert(!!data.session?.access_token, "sign-in succeeded but no access_token was returned");
      accessToken = data.session.access_token;
      primaryUser = { email, password, userId: userId!, accessToken };
      record("authentication", true);
    } catch (err) {
      overallFailure = true;
      throw err; // nothing authenticated-only below this point can run
    }

    const token = accessToken!;

    // 5. Authenticated profile read ------------------------------------------
    try {
      const profile = await apiCall<{ candidate?: { id?: string } }>("GET", "/profile", { token });
      assert(profile.status === 200, `expected 200, got ${profile.status} ${JSON.stringify(profile.body)}`);
      assert(!!profile.body.candidate?.id, "response missing candidate.id — candidate provisioning did not actually complete");
      record("profile read", true);
    } catch (err) {
      record("profile read", false, (err as Error).message);
      overallFailure = true;
    }

    // 6a. Consent gate (must be blocked before consent exists) --------------
    try {
      const gated = await apiCall<{ error?: string }>("POST", "/profile", { token, body: {} });
      assert(gated.status === 403 && gated.body.error === "consent_required", `expected 403 consent_required, got ${gated.status} ${JSON.stringify(gated.body)}`);
      record("consent gate", true);
    } catch (err) {
      record("consent gate", false, (err as Error).message);
      overallFailure = true;
    }

    // 6b. Consent creation ----------------------------------------------------
    try {
      const consent = await apiCall("POST", "/consent", { token, body: { consent_type: "data_processing" } });
      assert(consent.status === 201, `expected 201, got ${consent.status} ${JSON.stringify(consent.body)}`);
      record("consent creation", true);
    } catch (err) {
      record("consent creation", false, (err as Error).message);
      overallFailure = true;
    }

    // 6c. Profile write (now that consent exists) ------------------------------
    try {
      const write = await apiCall("POST", "/profile", {
        token,
        body: {
          legal_first_name: "Smoke",
          legal_last_name: "Test",
          email,
          location_country: "Testland",
        },
      });
      assert(write.status === 200, `expected 200, got ${write.status} ${JSON.stringify(write.body)}`);
      record("profile write", true);
    } catch (err) {
      record("profile write", false, (err as Error).message);
      overallFailure = true;
    }

    // 7. Representative CRUD (skill — simplest full-CRUD entity) ---------------
    try {
      const created = await apiCall<{ skill?: { id?: string; name?: string } }>("POST", "/skills", {
        token,
        body: { name: `Smoke Test Skill ${Date.now()}`, category: "tool" },
      });
      assert(created.status === 201 && !!created.body.skill?.id, `create failed: ${created.status} ${JSON.stringify(created.body)}`);
      const skillId = created.body.skill!.id!;

      const fetched = await apiCall<{ skill?: { id?: string } }>("GET", `/skills/${skillId}`, { token });
      assert(fetched.status === 200 && fetched.body.skill?.id === skillId, `fetch failed: ${fetched.status} ${JSON.stringify(fetched.body)}`);

      const deleted = await apiCall("DELETE", `/skills/${skillId}`, { token });
      assert(deleted.status === 204, `delete failed: expected 204, got ${deleted.status}`);

      record("representative CRUD", true);
    } catch (err) {
      record("representative CRUD", false, (err as Error).message);
      overallFailure = true;
    }

    // 8. Ownership isolation (RLS sanity check via a second disposable user) ---
    // Deliberately does NOT use the service-role key to "test RLS directly" —
    // that would prove nothing about what a real client can reach. Instead a
    // second real account is created and authenticated the normal way, then
    // used to attempt to read the first account's data through the public API.
    let ownershipSkillId: string | undefined;
    try {
      const ownershipSkill = await apiCall<{ skill?: { id?: string } }>("POST", "/skills", {
        token,
        body: { name: `Smoke Ownership Check ${Date.now()}`, category: "domain" },
      });
      assert(ownershipSkill.status === 201 && !!ownershipSkill.body.skill?.id, "could not create the record used for the ownership check");
      ownershipSkillId = ownershipSkill.body.skill!.id!;

      const secondEmail = newSmokeEmail();
      const secondPassword = generatePassword();
      const secondSignup = await apiCall<{ user_id?: string }>("POST", "/signup", {
        body: { email: secondEmail, password: secondPassword },
      });
      assert(secondSignup.status === 201 && !!secondSignup.body.user_id, "could not create the second disposable user for the ownership check");

      const { data: secondAuth, error: secondAuthError } = await authClient.auth.signInWithPassword({
        email: secondEmail,
        password: secondPassword,
      });
      assert(!secondAuthError && !!secondAuth?.session?.access_token, `could not authenticate the second disposable user: ${secondAuthError?.message ?? "no session"}`);
      const secondToken = secondAuth!.session!.access_token;

      try {
        const crossRead = await apiCall("GET", `/skills/${ownershipSkillId}`, { token: secondToken });
        assert(
          crossRead.status === 404,
          `expected the second account to be unable to read the first account's skill (404), got ${crossRead.status} ${JSON.stringify(crossRead.body)}`
        );
        record("ownership isolation", true);
      } finally {
        // Clean up the second user regardless of the assertion outcome above.
        const secondDelete = await apiCall("DELETE", "/account", { token: secondToken });
        if (secondDelete.status !== 204) {
          console.error(`Warning: cleanup of the second (ownership-check) disposable user may have failed — status ${secondDelete.status}`);
        }
      }
    } catch (err) {
      record("ownership isolation", false, (err as Error).message);
      overallFailure = true;
      // ownershipSkillId, if created, is left for the primary account's
      // own cascading DELETE /account cleanup below — no orphaned data.
    }

    // 9. Export -----------------------------------------------------------------
    try {
      const exported = await apiCall<{ candidate?: unknown; exported_at?: string; personal_info?: { legal_first_name?: string } | null }>(
        "GET",
        "/export",
        { token }
      );
      assert(exported.status === 200, `expected 200, got ${exported.status}`);
      assert(!!exported.body.candidate, "export missing candidate");
      assert(typeof exported.body.exported_at === "string", "export missing exported_at");
      assert(exported.body.personal_info?.legal_first_name === "Smoke", "export did not reflect the profile written earlier");
      record("export", true);
    } catch (err) {
      record("export", false, (err as Error).message);
      overallFailure = true;
    }

    // 10. Truth Center ------------------------------------------------------------
    try {
      const truthCenter = await apiCall<{ generated_at?: string; claims_needing_review_count?: number; groups?: unknown }>(
        "GET",
        "/truth-center",
        { token }
      );
      assert(truthCenter.status === 200, `expected 200, got ${truthCenter.status}`);
      assert(typeof truthCenter.body.generated_at === "string", "missing generated_at");
      assert(typeof truthCenter.body.claims_needing_review_count === "number", "missing claims_needing_review_count");
      assert(typeof truthCenter.body.groups === "object" && truthCenter.body.groups !== null, "missing groups");
      record("truth center", true);
    } catch (err) {
      record("truth center", false, (err as Error).message);
      overallFailure = true;
    }
  } catch (err) {
    // A step above intentionally threw to stop the flow (fatal steps only —
    // healthz, signup, authentication). The specific failure was already
    // recorded before the throw; this just prevents an unhandled rejection.
    overallFailure = true;
  } finally {
    // ── Cleanup — always attempted if we have an authenticated primary user ──
    if (primaryUser) {
      try {
        const deleted = await apiCall("DELETE", "/account", { token: primaryUser.accessToken });
        assert(deleted.status === 204, `expected 204, got ${deleted.status}`);

        // Best-effort verification: the same token should no longer resolve
        // a candidate once the underlying rows are cascade-deleted. This is
        // diagnostic, not authoritative — the 204 above is the real signal.
        const verify = await apiCall("GET", "/profile", { token: primaryUser.accessToken });
        const verified = verify.status === 401 || verify.status === 404;
        record("cleanup", true, verified ? undefined : `deleted (204), but post-delete verification returned ${verify.status} instead of 401/404 — token revocation may be eventually-consistent`);
      } catch (err) {
        record("cleanup", false, (err as Error).message);
        console.error(
          `\nCLEANUP FAILED. Orphaned account may remain.\n` +
            `Auth user id: ${primaryUser.userId}\n` +
            `Manual cleanup required via the Supabase dashboard (Authentication -> Users) ` +
            `if this is not resolved.\n`
        );
        overallFailure = true;
      }
    } else if (primaryUser === null) {
      // Either signup itself failed (nothing to clean up), or authentication
      // failed (already reported above with the orphaned user id, and this
      // script deliberately does not attempt a workaround for that case).
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const passedCount = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log("");
  console.log(overallFailure || passedCount < total ? `FAIL — ${passedCount}/${total} checks` : `PASS — ${passedCount}/${total} checks`);

  process.exit(overallFailure || passedCount < total ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected smoke-test crash:", sanitize((err as Error).message ?? String(err)));
  process.exit(1);
});
