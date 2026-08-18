# Phase B — Production Infrastructure — Progress

**Constraint carried through this entire phase: everything must run on
free tiers. Every recommendation below was checked against current 2026
pricing before being proposed — not assumed from older knowledge.**

## Done

- [x] **CI pipeline** (`.github/workflows/ci.yml`) — runs on every push
      and pull request to `main`:
      - API tests (167 vitest tests) + `tsc --noEmit`
      - Full RLS/ownership suite (all 12 SQL test files) against a
        disposable Postgres service container spun up inside the CI job
        itself
      - **Cost: $0.** GitHub Actions is free for this project (unlimited
        minutes on a public repo; 2,000 free minutes/month on a private
        repo, and this whole suite runs in well under a minute). No
        external accounts, secrets, or services required — the Postgres
        container is disposable and never touches a real Supabase
        project, matching how `tests/run_rls_tests.sh` already works
        locally.
      - This directly closes the "avoid rework" goal: every future phase
        (frontend, OAuth, LLM boundary, matching) now gets automatically
        checked against all 167 tests + 12 RLS suites on every change,
        so a regression is caught immediately instead of discovered
        later after more has been built on top of it.

## Pending your input (see questions below) — nothing built yet

- [ ] **API hosting** (where the Express API actually runs, not just on
      your laptop)
- [ ] **Production Supabase project** (separate from whatever you're
      using for local dev/testing)
- [ ] **Keepalive job** for the production Supabase project — needed
      because Supabase's free tier pauses a project after 7 days with no
      database activity; this is a scheduled GitHub Actions workflow
      (also free) once the production project exists, so it's blocked on
      that decision, not on any new unknown
- [ ] **Domain** — using a free subdomain from the hosting provider vs. a
      domain you already own

## Research notes (so the reasoning is visible, not just the conclusion)

Checked current (2026) free-tier terms before recommending anything,
since these change often and stale advice would cause exactly the kind
of rework this phase is meant to avoid:

- **Supabase free tier**: 500 MB database, 1 GB file storage, 5 GB
  egress, up to 2 active projects, no credit card required. The one real
  gotcha: a free project **pauses after 7 days with no database
  activity** and needs to be manually resumed (or automatically resumed
  by a config change) from the dashboard — this is the reason a keepalive
  job is worth setting up once a production project exists, rather than
  discovering the pause during a demo.
- **Render free tier** (candidate for API hosting): free web service
  (512 MB RAM), but **spins down after 15 minutes of inactivity** with a
  30–60 second cold-start on the next request. Free Postgres on Render is
  **hard-deleted after 30 days** — not a concern for us either way, since
  the plan is to keep using Supabase for the database regardless of where
  the API runs. One real caution: bandwidth overages can generate real
  charges even on Render's "free" plan, so this needs a conscious
  decision, not an assumption.
- **Fly.io**: the old always-on free tier is legacy-only and **no longer
  available to new signups** in 2026 — ruled out as an option for a new
  deployment.
- Ruled out spending any time on Heroku (no free tier since 2022).

None of this blocks moving forward — it just means the hosting choice is
a real trade-off (free + occasional cold start vs. paying something),
which needs your call rather than a silent default.

## Questions for you

1. **API hosting**: Render's free tier is the strongest zero-cost fit I
   found, but the trade-off is a 30–60 second delay on the first request
   after 15 minutes of no traffic (it spins back up automatically after
   that — this only affects response time, not correctness). Is that
   acceptable for now, or would you rather I look at a different
   free-tier option (e.g., accepting more setup complexity for something
   without cold starts)?
2. **Production Supabase project**: do you already have a Supabase
   project you consider "production," or is everything so far running
   against a single dev project? Free tier allows 2 active projects,
   which fits a clean dev/prod split. I can write the exact setup steps,
   but creating the project itself needs your Supabase login, so I can't
   do this part for you directly.
3. **Domain**: fine to launch on a free subdomain (e.g.
   `something.onrender.com`) for now, or do you already own a domain
   you'd want pointed at this?
4. **GitHub repo**: what's the repo path (e.g. `bunny/internshipos`)? I
   don't strictly need this to write the CI workflow (already done,
   works regardless), but I'll need it for anything that references the
   repo directly later (e.g. a deploy-on-push config tied to a specific
   provider).

Once these are answered, the rest of Phase B (actually wiring up hosting,
the keepalive job, and any deploy automation) can proceed without
guessing and without rework.
