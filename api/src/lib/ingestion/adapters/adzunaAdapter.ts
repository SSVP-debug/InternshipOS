// adzunaAdapter.ts
//
// Source #1 (India-first): Adzuna's official Jobs API —
// https://developer.adzuna.com/. Requires a free app_id/app_key
// (ADZUNA_APP_ID / ADZUNA_APP_KEY), issued instantly on signup. Queried
// against the India country code (`/v1/api/jobs/in/search/...`) with
// what=internship, which is exactly the sanctioned, documented
// integration path — not scraping.
//
// Adzuna has no structured skills field and no reliable structured
// work-mode signal, so both are left conservative here (skills: [],
// work_mode inferred only from an explicit "remote"/"hybrid" mention in
// the description, else null/unstated) rather than guessed. This
// mirrors the tri-state "NULL means unstated, never assumed" discipline
// already established for opportunity_source in 0022/0023 — inventing a
// free-text skill extractor for Adzuna specifically was considered and
// deferred as unnecessary complexity for this milestone.

import { cleanLine, cleanText, isInternshipRelevant, toIsoDate } from "../normalize.js";
import type { AdapterRunResult, CanonicalListing, SourceAdapter } from "../types.js";

const SOURCE_NAME = "adzuna";
const COUNTRY = "in";
const RESULTS_PER_PAGE = 50;
const PAGES_PER_RUN = 2; // keep the MVP's per-run volume small and predictable
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 500;

interface AdzunaCredentials {
  appId: string;
  appKey: string;
}

/** Raw shape of one result from Adzuna's /search response (fields this adapter uses only). */
interface AdzunaRawResult {
  id?: string;
  title?: string;
  company?: { display_name?: string };
  description?: string;
  location?: { display_name?: string };
  redirect_url?: string;
  created?: string; // ISO timestamp
}

interface AdzunaSearchResponse {
  results?: AdzunaRawResult[];
}

function buildSearchUrl(page: number, credentials: AdzunaCredentials): string {
  const params = new URLSearchParams({
    app_id: credentials.appId,
    app_key: credentials.appKey,
    what: "internship",
    results_per_page: String(RESULTS_PER_PAGE),
    "content-type": "application/json",
  });
  return `https://api.adzuna.com/v1/api/jobs/${COUNTRY}/search/${page}?${params.toString()}`;
}

/**
 * Builds a sanitized, human-readable description of the request that
 * failed — endpoint host, path, and non-secret query parameters (what,
 * results_per_page, content-type) — for inclusion in a non-2xx error.
 * `app_id` and `app_key` are completely redacted (never partially, never
 * their length or a prefix — the parameter names stay so it's clear
 * credentials *were* sent, but their values never appear). Built by
 * parsing the exact URL fetchWithRetry already requested, so it can
 * never drift from what was actually sent; does not change or
 * reconstruct the request itself.
 */
function sanitizeRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("app_id")) parsed.searchParams.set("app_id", "[redacted]");
    if (parsed.searchParams.has("app_key")) parsed.searchParams.set("app_key", "[redacted]");
    return `${parsed.origin}${parsed.pathname}?${parsed.searchParams.toString()}`;
  } catch {
    return "[unparseable request URL]";
  }
}

/**
 * Redacts credential material from a non-2xx response body before it's
 * embedded in a thrown/reported error. Adzuna auth-failure responses
 * have been observed to echo back the offending query string, so this
 * isn't purely defensive — both the exact configured app_id/app_key
 * values AND any generically-shaped app_id=.../app_key=... substring are
 * redacted (the latter as a belt-and-braces guard in case a different or
 * malformed key ends up in the body than the ones this adapter holds).
 * Also collapses whitespace and truncates, since this text is only for
 * diagnostics, not further parsing.
 */
function sanitizeErrorBody(rawBody: string, credentials: AdzunaCredentials): string {
  if (!rawBody) return "";

  let sanitized = rawBody;

  if (credentials.appId) {
    sanitized = sanitized.split(credentials.appId).join("[redacted]");
  }
  if (credentials.appKey) {
    sanitized = sanitized.split(credentials.appKey).join("[redacted]");
  }

  sanitized = sanitized
    .replace(/app_id=[^&\s"']+/gi, "app_id=[redacted]")
    .replace(/app_key=[^&\s"']+/gi, "app_key=[redacted]");

  sanitized = sanitized.replace(/\s+/g, " ").trim();

  return sanitized.length > MAX_ERROR_BODY_LENGTH ? `${sanitized.slice(0, MAX_ERROR_BODY_LENGTH)}…` : sanitized;
}

async function fetchWithRetry(url: string, credentials: AdzunaCredentials): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });

      if (!response.ok) {
        const sanitizedUrl = sanitizeRequestUrl(url);
        const rawBody = await response.text().catch(() => "");
        const sanitizedBody = sanitizeErrorBody(rawBody, credentials);
        throw new Error(
          `Adzuna request failed — ${sanitizedUrl} — HTTP ${response.status}${sanitizedBody ? `: ${sanitizedBody}` : ""}`
        );
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const REMOTE_HINT = /\bremote\b/i;
const HYBRID_HINT = /\bhybrid\b/i;

function inferWorkMode(description: string | null): CanonicalListing["work_mode"] {
  if (!description) return null;
  if (HYBRID_HINT.test(description)) return "hybrid";
  if (REMOTE_HINT.test(description)) return "remote";
  return null;
}

/**
 * Parses one page's raw Adzuna response into CanonicalListing[]. Pure
 * (given already-fetched JSON), no network — exercised directly by
 * tests against a saved fixture.
 */
export function parseAdzunaListings(raw: unknown): { listings: CanonicalListing[]; fetched: number } {
  const response = (raw ?? {}) as AdzunaSearchResponse;
  const results = Array.isArray(response.results) ? response.results : [];

  const listings: CanonicalListing[] = [];

  for (const result of results) {
    const title = cleanLine(result.title ?? null);
    const company = cleanLine(result.company?.display_name ?? null);
    if (!title || !company || !result.id) continue;

    const description = cleanText(result.description ?? null);
    if (!isInternshipRelevant(title, description)) continue;

    listings.push({
      source_type: "job_board",
      source_name: SOURCE_NAME,
      source_ref: String(result.id),
      source_url: result.redirect_url ?? null,
      title,
      company,
      description,
      location: cleanLine(result.location?.display_name ?? null),
      work_mode: inferWorkMode(description),
      employment_type: "internship",
      skills: [],
      application_url: result.redirect_url ?? null,
      deadline_date: null, // Adzuna does not publish application deadlines
      posted_date: toIsoDate(result.created ?? null),
    });
  }

  return { listings, fetched: results.length };
}

/**
 * Reads ADZUNA_APP_ID / ADZUNA_APP_KEY from the given env source
 * (defaults to process.env). Returns null (not a throw) when either is
 * missing, so the orchestrator can skip this source with a clear error
 * instead of crashing the whole ingestion run.
 */
function readCredentials(env: NodeJS.ProcessEnv): AdzunaCredentials | null {
  const appId = env.ADZUNA_APP_ID;
  const appKey = env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return null;
  return { appId, appKey };
}

export function createAdzunaAdapter(env: NodeJS.ProcessEnv = process.env): SourceAdapter {
  return {
    sourceName: SOURCE_NAME,
    async run(): Promise<AdapterRunResult> {
      const errors: string[] = [];
      const credentials = readCredentials(env);

      if (!credentials) {
        errors.push("Missing ADZUNA_APP_ID / ADZUNA_APP_KEY — skipping Adzuna for this run.");
        return { sourceName: SOURCE_NAME, fetched: 0, keptAfterFilter: 0, listings: [], errors };
      }

      let totalFetched = 0;
      const allListings: CanonicalListing[] = [];

      for (let page = 1; page <= PAGES_PER_RUN; page++) {
        try {
          const raw = await fetchWithRetry(buildSearchUrl(page, credentials), credentials);
          const { listings, fetched } = parseAdzunaListings(raw);
          totalFetched += fetched;
          allListings.push(...listings);
          // Adzuna returns fewer than a full page on the last page —
          // stop paging early instead of always making PAGES_PER_RUN calls.
          if (fetched < RESULTS_PER_PAGE) break;
        } catch (error) {
          errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
          break; // don't keep paging past a failed page
        }
      }

      return { sourceName: SOURCE_NAME, fetched: totalFetched, keptAfterFilter: allListings.length, listings: allListings, errors };
    },
  };
}
