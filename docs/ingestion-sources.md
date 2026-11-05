# Ingestion sources

`npm run ingest` (and the daily GitHub Actions pipeline) reads internship
postings from every source below, in parallel, and upserts them into
`public.opportunity_source`. Each source is one adapter in
`api/src/lib/ingestion/adapters/`; each writes its own `source_name`.

| `source_name` | What it reads | Credentials | Coverage |
|---|---|---|---|
| `adzuna` | Adzuna Jobs API, India market, `what=internship` | `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` (free). Skipped if unset. | Pages of 50 until a short page; up to `ADZUNA_MAX_PAGES` (default 10, max 40). |
| `remoteok` | RemoteOK public feed, `tag=internship` | none | Whole feed. |
| `remotive` | Remotive public API, `search=intern` | none | Whole result set, **one request per run** (their limit is ~2/min; feed is ~24h delayed). |
| `greenhouse` | Each company in `config/ats-boards.json` → `greenhouse` | none | Every job on each configured board. |
| `lever` | Same, `lever` section | none | Every posting on each configured site (US-region Lever only). |
| `ashby` | Same, `ashby` section | none | Every job on each configured board. |

## Adding companies (Greenhouse / Lever / Ashby)

Edit `api/config/ats-boards.json` (or point `ATS_BOARDS_FILE` at another file).
Each ATS maps to an array; an entry is a slug string or `{ "slug", "company" }`:

```json
{
  "greenhouse": ["stripe", { "slug": "gitlab", "company": "GitLab" }],
  "lever": ["spotify"],
  "ashby": ["ramp"]
}
```

The slug is the last path segment of the company's careers URL:

| Careers URL | ATS | Slug |
|---|---|---|
| `boards.greenhouse.io/stripe` or `job-boards.greenhouse.io/stripe` | greenhouse | `stripe` |
| `jobs.lever.co/spotify` | lever | `spotify` |
| `jobs.ashbyhq.com/ramp` | ashby | `ramp` |

The ATS APIs return no company name, so give `company` for a proper display
name; otherwise it is derived from the slug (`my-startup` → `My Startup`).
Invalid slugs are skipped with a warning; a slug the ATS does not know is
reported as `board not found` for that board only — other boards still run.

The seed list in the repo is a small set of well-known boards to prove the
plumbing. Replace it with companies you actually want to track.

## Behavior worth knowing

- **Internship filter.** Adzuna/RemoteOK/Remotive accept a title *or*
  description match (their queries are already scoped to internships). The ATS
  adapters are stricter — title match, or the ATS's own structured
  type (`Intern` on Ashby, `commitment` on Lever) — because a company board is
  not scoped, and a description scan would admit full-time roles whose
  boilerplate mentions an internship program.
- **Stable ids.** ATS `source_ref` is `"<slug>:<job id>"`, so ids never collide
  across companies and re-runs upsert instead of duplicating.
- **Cross-source duplicates** (same internship on two sources) are collapsed at
  read time by `opportunityFeed.ts`, as before.
- **Eligibility columns** stay `null` ("not stated") except
  `sponsorship_offered` (narrow phrase extraction). Location text such as
  "USA Only" is kept for display but is not mapped to an eligibility country.
- **Failures are isolated.** A failing source or board is reported in the run
  summary and never stops the others. The run exits non-zero only if every
  source failed.
- **Expiry.** The existing 14-day `last_seen_at` sweep applies to every source:
  a posting that disappears from its board expires on its own.

## First live run checklist

The adapters were built against each vendor's documented response shape and
tested with saved fixtures; the very first run against the real services
should be read, not assumed:

1. `cd api && npm run ingest` with your usual env vars.
2. Every source prints `fetched` (raw jobs seen) and `kept (internships)`.
   `fetched > 0` with `kept = 0` is normal for a board with no open
   internships; `fetched = 0` with an error is not.
3. `greenhouse/<slug>: board not found` → fix the slug in `ats-boards.json`.
4. A vendor changing its response shape shows up as `fetched > 0` on a board
   that should have internships but `kept = 0` everywhere — compare one raw
   response against the parser in the adapter's header notes.
