# Gate R8 — External ATS Submission (Lever only)

> ## ⚠️ CORRECTION (2026-09-19) — the submission path described below does not work
>
> Everything in this document was written on a false premise. I assumed
> Lever's public Postings API let a third party submit an application
> without any employer-issued credential — the same public/keyless
> access its **read** endpoint (`GET /v0/postings/...`) genuinely has.
> That assumption was never checked against Lever's own documentation
> before `leverAdapter.ts` was built on top of it.
>
> Lever's own canonical docs (`github.com/lever/postings-api`) state the
> submission endpoint plainly:
>
> > `POST /v0/postings/SITE/POSTING-ID?key=APIKEY`
> >
> > To use the POST API, **you need an API key, which a Super Admin of
> > your account can generate** from your integrations settings page.
>
> That key belongs to the *employer's* Lever account. A candidate-side
> tool like InternshipOS has no way to obtain one for an arbitrary
> company — the same reason Greenhouse doesn't work (see the "Why Lever,
> and only Lever" section below, which is itself now half-wrong: Lever
> is not the exception it was claimed to be).
>
> **Practical effect:** `submitLeverApplication()` sends a plain `POST`
> with no `key` parameter. Against a real posting, every non-dry-run
> submission this feature attempts would fail with an authentication
> error. The `GET` posting-fetch calls (`getLeverPosting()`) are fine —
> that part of the public API is real. The submission part is not.
>
> **Broader finding, not just Lever:** the same session that caught this
> also checked Greenhouse, Workable, SmartRecruiters, Breezy HR, Ashby,
> and Recruitee. All seven platforms checked — Lever included — require
> an employer-issued API key or OAuth token to submit an application
> programmatically. None has a public, candidate-callable submission
> endpoint. The premise that justified this entire gate — "Lever is
> different from the others" — does not hold. Real automated submission
> to any of these platforms requires either credentials a candidate
> cannot obtain, or browser automation mimicking a human filling the
> hosted form (the harder, previously-deferred path).
>
> Everything below this notice describes the feature as it was designed
> and built, kept for the historical record and because the `GET`
> posting-fetch logic and the safety-rail design (kill switch, dry-run,
> per-item review) are still sound patterns even though the submission
> call itself doesn't work. Treat any claim below that Lever's
> submission endpoint is "public" or "no-auth" as superseded by this
> notice.

**Status:** Implemented, including a bulk variant and a template-based
cover-letter draft. Migration `0030_application_ats_submission.sql`,
`api/src/lib/ats/leverAdapter.ts`, `api/src/lib/ats/attemptAtsSubmission.ts`
(the shared core logic, used by both the single and bulk routes),
`api/src/lib/ats/coverLetterTemplate.ts`,
`POST /applications/:id/submit-to-ats`,
`POST /opportunity-matches/bulk-submit-to-ats`, and
`GET /applications/:id/cover-letter-draft` are all in place, with tests
(`tests/leverAdapter.test.ts`, `tests/application.submit-to-ats.test.ts`,
`tests/opportunity-feed.route.test.ts`'s bulk-submit block,
`tests/coverLetterTemplate.test.ts`,
`tests/application.cover-letter-draft.test.ts`, `tests/env.test.ts`).
Frontend: a single-item button on the application detail page, a bulk
button in the feed's multi-select bar, and a "Generate draft" /
editable-textarea flow for the cover letter. Not yet exercised against a
live Lever posting — see "What is genuinely unverified" below before
trusting this in production.

## Why this document exists

`docs/gate-r0-resume-design.md` recorded an explicit decision: *"Real
form-submission/browser automation — explicitly out of scope per your
Gate R0 answer, its own future gate if ever pursued."* This gate is that
future gate. It's scoped much narrower than "auto-apply to anything" —
this document exists so that narrowing is explicit and reviewable, the
same way R0 made the original exclusion explicit.

## What this gate actually does

One new route: `POST /applications/:id/submit-to-ats`. Given an existing
`application` row, it:

1. Confirms external submission is enabled at all (`EXTERNAL_ATS_SUBMISSION_ENABLED`,
   off by default — see env.ts).
2. Confirms the application hasn't already been submitted or moved past
   that point (only `SAVED`/`APPLYING` are eligible).
3. Confirms the linked opportunity's `application_url` is a Lever-hosted
   posting (`jobs.lever.co/{site}/{postingId}`) — anything else is
   rejected with `unsupported_ats`, not attempted.
4. Confirms the linked resume has an actual uploaded file behind it (not
   just a resume *record* — an `evidence_source` row of type
   `document_upload`).
5. Confirms `personal_info` has at least a legal name and email.
6. Fetches the live posting from Lever to confirm it's still
   `published` (not closed/removed).
7. If `dry_run` (the default): stops here and returns exactly what
   *would* be submitted, without contacting Lever's submit endpoint at
   all.
8. If `dry_run: false`: downloads the resume file, submits it to
   Lever's public postings-apply endpoint, and on success advances the
   application's status (`SAVED`→`APPLYING`→`APPLIED`, respecting the
   existing state-machine trigger — see `0018_application.sql`) and
   records `ats_provider`/`ats_submitted_at` (`0030`'s migration).

## Why Lever, and only Lever

Lever's public Postings API includes a submission endpoint
(`POST https://api.lever.co/v0/postings/{site}/{postingId}`) that is the
*same endpoint Lever's own hosted apply page posts to* — it's public by
construction, not something requiring an employer-issued credential.
That's what makes it uniquely reachable by a candidate-side tool like
this one.

This is **not** true of the other major ATS platforms:

- **Greenhouse** — its public Job Board API
  (`boards-api.greenhouse.io`) is read-only (list/get postings). There
  is no equivalent public submission endpoint a third-party candidate
  tool can call; real submission goes through each employer's own
  embedded form, which isn't a generic, scriptable target. (I said
  otherwise earlier in this conversation, before checking — that was
  wrong, and this gate does not include Greenhouse as a result.)
- **Workday, iCIMS, SmartRecruiters, and most in-house career sites** —
  no public submission API at all; each is a bespoke form, frequently
  with anti-automation measures, and would require per-employer
  browser automation rather than an API integration. That's a
  fundamentally different (and much less reliable, more fragile, more
  ToS-risky) undertaking than this gate, and is explicitly **not** what
  was built here.

If a future gate wants to extend coverage, the honest next step is
evaluating each additional ATS's actual submission surface on its own
merits — not assuming "if Lever has one, they all do."

## Deliberate limitations (not bugs)

- **No custom application-question support.** Lever postings can define
  employer-specific screening questions beyond the base fields (name,
  email, phone, resume, comments). There's no reliable way to discover
  a posting's custom-question schema from the public read API, so this
  adapter doesn't attempt to. It only ever sends the base fields. If a
  posting requires more than that, the expected outcome is that Lever's
  own endpoint rejects the submission server-side (missing required
  field) — surfaced as an ordinary `ats_submission_failed` error, never
  silently swallowed or retried with guessed answers. A candidate can
  still apply to that specific posting manually via the existing "Open
  listing" link.
- **`dry_run` defaults to `true`.** A caller that omits the field, or a
  client that hasn't been updated to think carefully about this,
  physically cannot trigger a real submission by accident.
- **`EXTERNAL_ATS_SUBMISSION_ENABLED` defaults to `false`.** A second,
  independent layer — a fresh deploy or a forgotten env var never
  exposes live submission.
- **No frontend button yet.** ~~This gate is API-only.~~ Superseded — the
  frontend now has a single-item button (application detail page), a
  bulk button (feed multi-select bar, capped at 5 per batch —
  `BulkSubmitToAtsRequestSchema`, deliberately lower than bulk-apply's
  20 since these are real, irreversible submissions), and a cover-letter
  draft flow. All three still gated behind the same
  `EXTERNAL_ATS_SUBMISSION_ENABLED` switch and per-request `dry_run`
  default.
- **Cover letters are templated, not AI-generated.** `GET
  /applications/:id/cover-letter-draft` assembles a draft from data
  already on file (candidate name, resume label, matched skills,
  opportunity title/company) via a plain string template
  (`coverLetterTemplate.ts`) — not an LLM call. This codebase has no LLM
  integration (no Anthropic/OpenAI key, no wiring anywhere), and adding
  one is a deliberate cost/infra decision for the project owner, not
  something to slip in as a side effect. The draft deliberately includes
  an obvious placeholder line for "why this role specifically" rather
  than inventing enthusiasm — a template has no way to know that, and
  shouldn't pretend to.

## What is genuinely unverified

This environment's network egress does not allow reaching
`api.lever.co`, so **none of this has been exercised against Lever's
live API** — only against mocked `fetch` responses matching documented
Lever behavior. The request shape (multipart form fields: `name`,
`email`, `phone`, `resume`, `comments`) is built from publicly known,
stable Lever Postings API behavior, but:

- Lever's API could have changed since training data was current.
- Some individual employer Lever configurations may behave differently
  than the documented default (e.g. requiring fields this adapter
  doesn't send).

**Before trusting this for a real application:** test with `dry_run:
true` first and inspect the `would_submit` payload, then test a real
(`dry_run: false`) submission against a posting you don't mind
duplicating your own manual application to (there's no Lever sandbox
mode for arbitrary third-party postings), and confirm you actually
receive Lever's confirmation email before relying on this for anything
that matters.

## Data/trust surface this gate adds

This is the first route in the codebase that sends a candidate's PII
(name, email, phone) and an uploaded document to a third party
unattended, rather than only ever reading/writing the candidate's own
Supabase-backed data. That's a materially different trust boundary than
anything else in this API, which is the main reason for the two
independent kill switches above rather than just shipping the route
live. Worth keeping in mind before extending this pattern to any
additional ATS.
