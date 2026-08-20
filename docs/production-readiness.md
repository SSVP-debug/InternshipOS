# Production Readiness

This doc is the engineering-foundation counterpart to
`docs/candidate-truth-layer-phase0.md` (the product architecture). It
covers how the API actually starts, what it needs, how to tell if it's
healthy, and what is/isn't handled today. Written as part of an
engineering-infrastructure pass — see `docs/decisions-log.md` for
narrower design decisions.

## How the application starts

```
cd api
npm ci
npm run build      # tsc emit -> dist/
npm start           # node dist/server.js
```

or for local development: `npm run dev` (tsx watch, no build step).

Startup order, in `src/server.ts`:
1. `loadEnv()` parses `process.env` against a Zod schema and throws
   immediately (before any HTTP listener opens) if anything required is
   missing or malformed. There is no "start anyway with defaults" path
   for secrets.
2. `createApp(env)` assembles the Express app: security headers (helmet),
   CORS, request logging, rate limiting, `express.json()`, health
   endpoints, then every route, then the 404/error handlers last.
3. `app.listen(env.PORT, ...)` binds and logs a single structured
   "listening" line.

## Required environment variables

See `api/.env.example` for the full, authoritative list with comments.
Summary:

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | must be a valid URL |
| `SUPABASE_ANON_KEY` | yes | used for every per-candidate request |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | used ONLY by `POST /signup` and `DELETE /account` (see `src/lib/supabaseClient.ts`) |
| `PORT` | no (default 3000) | |
| `CONSENT_POLICY_VERSION` | no (default `v1.0`) | stamped onto new `consent_record` rows |
| `NODE_ENV` | no (default `development`) | controls log formatting only — never gates which secret is read |
| `ALLOWED_ORIGINS` | no (default: none) | comma-separated browser origins allowed via CORS; unset = no browser can call the API cross-origin |
| `SIGNUP_RATE_LIMIT_MAX` | no (default 10) | per-IP signup attempts per window |
| `RATE_LIMIT_WINDOW_MINUTES` | no (default 15) | shared window for both rate limiters |
| `LOG_LEVEL` | no (default `info`/`debug`) | pino level override |

There is deliberately no environment-specific fallback for any secret —
every one of `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` is always required, in every `NODE_ENV`, with
no default value, so there is no code path where a missing production
secret silently falls back to a development value.

## Migrations

Migrations are plain, ordered SQL in `supabase/migrations/`, applied via
the Supabase CLI (`supabase db push`) or directly with `psql` in
numeric order — see the root `README.md` §1. There is no separate
migration-runner service; this is a manual, reviewed step against the
target Supabase project, not something the API applies on boot.

## Health checks

- `GET /healthz` — liveness. No dependency checks; answers "is the
  process up." Use this for basic uptime/restart-on-crash monitoring.
- `GET /readyz` — readiness. Makes one ~3s-timeout round-trip to
  Supabase's PostgREST root and returns `200 {"ready":true,...}` or
  `503 {"ready":false,...}`. Use this to gate traffic (e.g. a load
  balancer's health check) — a `503` here means "up, but can't currently
  serve real requests," which is a meaningfully different signal from a
  crashed process.

Neither endpoint requires a JWT, and neither returns any config value
(no URLs, no key fragments) — only a boolean-ish status.

## Logging / observability

Structured JSON logs via `pino` (human-readable via `pino-pretty` outside
`NODE_ENV=production`), one line per request (method, path, status,
duration, request id) plus explicit `logger.error/.fatal` calls on
unhandled errors and process-level crash events. See
`src/lib/logger.ts` for the redaction list — it is the single place that
defines what must never appear in a log line
(`Authorization`/`Cookie` headers, passwords, access/refresh tokens, the
service-role key). Every request gets an `X-Request-Id` (reused from an
inbound header if present, e.g. from Render's edge, otherwise generated),
echoed back in the response for correlating a client-reported issue with
a server log line.

No external log/metrics vendor is wired in. If one is added later
(Datadog, Sentry, etc.), the natural integration point is a pino
transport or a `res.on("finish")`-style hook — not a rewrite of the
logging call sites, which already emit structured objects.

## Rate limiting

In-process (`express-rate-limit`), not Redis-backed. This is
deliberately *not* a gap being papered over: the current deployment model
is a single Render web service instance (see below), so an in-memory
limiter is correct for one process. If this API ever scales to more than
one instance, the limiter needs to move to a shared store (Redis, etc.)
or it becomes "per-instance" rather than "per-deployment" — that
infrastructure is not built here ahead of the need.

- `POST /signup` (the one unauthenticated, account-creating route):
  `SIGNUP_RATE_LIMIT_MAX` requests per IP per `RATE_LIMIT_WINDOW_MINUTES`
  (default 10 / 15 min).
- Every other route: a generous general limiter (300 / 15 min) as
  defense-in-depth against basic flooding — every other route already
  requires a valid Supabase JWT, which is a much higher bar than an
  anonymous request.

## CORS

Opt-in via `ALLOWED_ORIGINS`. Unset means no browser page on any origin
can successfully call this API (non-browser callers — curl,
server-to-server, the smoke test — are unaffected; CORS is enforced by
the browser, not the server). Set `ALLOWED_ORIGINS` to the real
frontend's origin(s) before pointing a browser-based client at this API.

## Deployment model (Render)

- Single web service, auto-deploy from GitHub on push to `main` (per
  existing project memory/README conventions — no Dockerfile or
  container config exists in this repo; Render builds directly from
  `api/package.json`'s `build`/`start` scripts).
- `npm ci && npm run build` as the build command, `npm start` as the
  start command (adjust in Render's dashboard if it currently runs `npm
  run dev` — `dev` is not appropriate for production, it never compiles
  and holds a `tsx watch` process).
- Shuts down gracefully on `SIGTERM` (see `src/server.ts`): stops
  accepting new connections, lets in-flight requests finish, then exits;
  force-exits after a 10s grace period if something hangs. Render sends
  `SIGTERM` before a hard kill on deploys/restarts, so this avoids
  dropping in-flight requests on a routine redeploy.
- No horizontal scaling is configured. If that changes, revisit the
  rate-limiter note above.

### Supabase free-tier keepalive

`.github/workflows/supabase-keepalive.yml` pings the production Supabase
project's PostgREST root every 3 days (free-tier projects pause after 7
days of inactivity). Requires `SUPABASE_URL` and `SUPABASE_ANON_KEY` as
GitHub repo secrets — see the workflow file's header comment for setup.

## Backups / data recovery

This repo does not implement application-level backups — Supabase's
managed Postgres provides point-in-time recovery / backups as a
project-tier feature, configured in the Supabase dashboard, not in this
codebase. **Action required at the infrastructure level**: confirm the
target Supabase project's backup/PITR settings match the desired
retention before relying on this for recovery; the free tier's backup
guarantees are more limited than paid tiers. This is a provider
configuration to verify, not something this pass can add in code.

Account deletion (`DELETE /account`) is real and destructive — see the
extensive comment in `src/routes/account.ts` and
`tests/rls/test_account_deletion_cascade.sql`. There is no soft-delete or
recovery path for a deleted account; this is the documented, tested,
intentional product behavior (§6 of the Phase 0 architecture doc), not
an oversight.

## Known gaps / deliberately not built here

- **Distributed rate limiting** — see "Rate limiting" above.
- **`subject_entity_id` orphan checking** — `claim.subject_entity_id`
  has no DB-level foreign key (Postgres can't FK one column across
  multiple target tables; see the design note in
  `supabase/migrations/0016_claim.sql`). `api/scripts/check-orphan-
  claims.ts` is the manual/operator-run integrity check called for in
  that migration's comments — run it periodically
  (`npm run check:orphan-claims`, requires `SUPABASE_SERVICE_ROLE_KEY`);
  it is not wired into CI or a cron job, since neither existed as
  infrastructure to hook into.
- **Evidence Storage purge on deletion** — flagged as a known gap
  directly in `src/routes/account.ts`'s comments: no file-upload flow
  exists yet in this snapshot of the repo, so there's no Storage bucket
  convention to purge against. Revisit when/if an upload endpoint is
  built.
- **A shared/Redis-backed cache or session store** — nothing in this API
  needs one today (every route is either stateless or reads/writes
  directly through RLS-scoped Postgres queries); not added speculatively.
- **A dedicated APM/error-tracking vendor** — see "Logging /
  observability" above; the logging foundation is vendor-neutral and
  ready to feed one, but none is configured.
