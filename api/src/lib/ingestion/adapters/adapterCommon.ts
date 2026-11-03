// adapterCommon.ts
//
// Shared building blocks for the multi-board source adapters added in the
// "more sources" ingestion phase: Remotive, and the public job-board APIs
// of Greenhouse, Lever and Ashby. adzunaAdapter.ts and remoteokAdapter.ts
// predate this file and keep their own (equivalent) fetch/retry code
// untouched — nothing here changes their behavior.
//
// What lives here, and why it is shared:
//   - fetchJsonWithRetry: one retry/backoff/timeout policy for every new
//     adapter (retry network errors, timeouts, HTTP 429 and 5xx; never
//     retry other 4xx — a 404 for a company board slug is a config
//     problem, not a transient failure).
//   - mapWithConcurrency: bounded parallelism across company boards, so a
//     config with 100 boards does not open 100 sockets at once.
//   - loadAtsBoardsConfig / parseAtsBoardsConfig: the list of company
//     boards to read, from a JSON file (default api/config/ats-boards.json,
//     override with ATS_BOARDS_FILE). Validated: a bad entry is skipped
//     with a warning, never allowed to build a malformed request URL.
//   - buildAtsListing: the one place a CanonicalListing is assembled for
//     the ATS adapters, so every eligibility column is explicitly null
//     ("not stated") exactly as adzunaAdapter.ts / remoteokAdapter.ts do.
//   - createBoardsAdapter: the generic "for each configured board, fetch
//     + parse, isolate failures per board" runner the three ATS adapters
//     are thin wrappers around.
//
// Nothing in this file performs I/O at import time.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { cleanLine, cleanText, isInternshipRelevant } from "../normalize.js";
import { extractSkillsFromText } from "../extractSkills.js";
import { extractSponsorshipSignal } from "../extractEligibilitySignals.js";
import { normalizeSkillList } from "../../skillNormalization.js";
import type { AdapterRunResult, CanonicalListing, SourceAdapter } from "../types.js";

export const ADAPTER_USER_AGENT = "InternshipOS-Ingestion/0.2 (+https://github.com/SSVP-debug/InternshipOS)";

/** Descriptions are stored in a plain text column; bound them so one huge posting cannot bloat a row. */
export const MAX_DESCRIPTION_CHARS = 20_000;

// ── HTTP ─────────────────────────────────────────────────────────────────

/** Thrown for a non-2xx response. `status` lets callers special-case 404 without string matching. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface FetchJsonOptions {
  /** Defaults to the global `fetch`, resolved at call time so tests can stub it. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  /** Injected by tests so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 10_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parses a Retry-After header given in seconds; returns null if absent/unparseable. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * GETs `url` and parses the JSON body.
 *
 * Retries (exponential backoff, honoring Retry-After on 429) on network
 * errors, timeouts, HTTP 429 and HTTP 5xx. Any other non-2xx response
 * throws HttpStatusError immediately, with no retry.
 */
export async function fetchJsonWithRetry(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let waitMs = baseDelayMs * 2 ** (attempt - 1);

    try {
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": ADAPTER_USER_AGENT, Accept: "application/json" },
      });

      if (!response.ok) {
        const error = new HttpStatusError(response.status, `HTTP ${response.status} from ${new URL(url).host}`);
        if (!isRetryableStatus(response.status)) throw error;
        lastError = error;
        waitMs = retryAfterMs(response) ?? waitMs;
      } else {
        return await response.json();
      }
    } catch (error) {
      if (error instanceof HttpStatusError && !isRetryableStatus(error.status)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < maxRetries) await sleep(waitMs);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ── Concurrency ──────────────────────────────────────────────────────────

/** Maps `items` through `fn` with at most `limit` calls in flight. Results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ── Text helpers ─────────────────────────────────────────────────────────

/**
 * Decodes the HTML entities Greenhouse uses to escape its `content` field
 * (e.g. "&lt;p&gt;" → "<p>"), so cleanText's tag-stripping can see the
 * real tags. `&amp;` is decoded last so "&amp;lt;" is not double-decoded.
 */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeFromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

/** Entity-decodes, strips tags, collapses whitespace, and bounds the length. Null for empty input. */
export function htmlToBoundedText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = cleanText(decodeHtmlEntities(raw));
  if (!text) return null;
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
}

/** Plain-text variant for sources that already return plaintext (Lever/Ashby `descriptionPlain`). */
export function plainToBoundedText(raw: string | null | undefined): string | null {
  const text = cleanLine(raw ?? null);
  if (!text) return null;
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
}

/**
 * Work mode from a free-text location string. Only an explicit word counts:
 * "Remote - India" → remote, "Hybrid (Bengaluru)" → hybrid, anything else →
 * null (unstated). Never guessed from a city name.
 */
export function workModeFromLocationText(location: string | null): CanonicalListing["work_mode"] {
  if (!location) return null;
  if (/\bremote\b/i.test(location)) return "remote";
  if (/\bhybrid\b/i.test(location)) return "hybrid";
  return null;
}

/** Strict title-only internship check (no description scan). See the ATS adapters' headers for why. */
export function titleSignalsInternship(title: string): boolean {
  return isInternshipRelevant(title, null);
}

// ── Listing builder ──────────────────────────────────────────────────────

export interface AtsListingInput {
  sourceName: string;
  sourceRef: string;
  sourceUrl: string | null;
  applicationUrl: string | null;
  title: string;
  company: string;
  description: string | null;
  location: string | null;
  workMode: CanonicalListing["work_mode"];
  postedDate: string | null;
  /** Source-supplied skill tags, if the source has any (Remotive does). Merged with text extraction. */
  sourceSkills?: readonly string[];
}

/**
 * Assembles a CanonicalListing. Every eligibility column except
 * sponsorship_offered (narrow phrase extraction, same rule as the other
 * adapters) is null: none of these sources states those axes in a
 * structured, reliable way. `jurisdiction_country` is null too — a global
 * company board does not scope its postings to one country the way
 * Adzuna's per-country endpoint does.
 */
export function buildAtsListing(input: AtsListingInput): CanonicalListing {
  const extracted = extractSkillsFromText(input.title, input.description);
  const skills = normalizeSkillList([...(input.sourceSkills ?? []), ...extracted]);

  return {
    source_type: "job_board",
    source_name: input.sourceName,
    source_ref: input.sourceRef,
    source_url: input.sourceUrl,
    title: input.title,
    company: input.company,
    description: input.description,
    location: input.location,
    work_mode: input.workMode,
    employment_type: "internship",
    skills,
    application_url: input.applicationUrl,
    deadline_date: null, // none of these public APIs publish an application deadline
    posted_date: input.postedDate,

    sponsorship_offered: extractSponsorshipSignal(input.title, input.description),
    citizenship_requirement: null,
    jurisdiction_country: null,
    eligible_candidate_countries: null,
    citizenship_required_countries: null,
    requires_existing_work_authorization: null,
    required_degree_types: null,
    required_majors: null,
    required_major_match_mode: null,
    graduation_not_before: null,
    graduation_not_after: null,
    required_enrollment_statuses: null,
  };
}

// ── Board configuration ──────────────────────────────────────────────────

export type AtsName = "greenhouse" | "lever" | "ashby";
export const ATS_NAMES: readonly AtsName[] = ["greenhouse", "lever", "ashby"];

export interface AtsBoardRef {
  /** The board token as it appears in the company's careers URL (e.g. "stripe"). */
  slug: string;
  /** Display name stored on each listing, since the ATS APIs do not return one. */
  company: string;
}

export type AtsBoardsConfig = Record<AtsName, AtsBoardRef[]>;

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function companyFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function emptyAtsBoardsConfig(): AtsBoardsConfig {
  return { greenhouse: [], lever: [], ashby: [] };
}

/**
 * Validates the raw JSON of ats-boards.json.
 *
 * Accepted shape — each ATS maps to an array whose entries are either a
 * slug string or { "slug": "...", "company": "..." }:
 *   { "greenhouse": ["stripe", { "slug": "gitlab", "company": "GitLab" }],
 *     "lever": ["spotify"], "ashby": ["ramp"] }
 *
 * Invalid entries are skipped with a warning (prefixed "<ats>: ") rather
 * than failing the whole file; duplicate slugs within one ATS keep the
 * first occurrence.
 */
export function parseAtsBoardsConfig(raw: unknown): { config: AtsBoardsConfig; warnings: string[] } {
  const config = emptyAtsBoardsConfig();
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("ats-boards config must be a JSON object keyed by ATS name — ignoring it");
    return { config, warnings };
  }

  const record = raw as Record<string, unknown>;

  for (const ats of ATS_NAMES) {
    const entries = record[ats];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      warnings.push(`${ats}: expected an array of boards — ignoring this section`);
      continue;
    }

    const seen = new Set<string>();
    for (const entry of entries) {
      const slug = typeof entry === "string" ? entry.trim() : typeof (entry as { slug?: unknown })?.slug === "string" ? ((entry as { slug: string }).slug.trim()) : "";
      if (!SLUG_PATTERN.test(slug)) {
        warnings.push(`${ats}: skipping invalid board slug ${JSON.stringify(entry)}`);
        continue;
      }
      if (seen.has(slug.toLowerCase())) continue;
      seen.add(slug.toLowerCase());

      const explicitCompany = typeof entry === "object" && entry !== null ? cleanLine((entry as { company?: string }).company ?? null) : null;
      config[ats].push({ slug, company: explicitCompany ?? companyFromSlug(slug) });
    }
  }

  return { config, warnings };
}

/** Default location of the boards file, relative to the process working directory (api/ in CI and `npm run ingest`). */
export function defaultAtsBoardsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATS_BOARDS_FILE ? path.resolve(env.ATS_BOARDS_FILE) : path.resolve(process.cwd(), "config", "ats-boards.json");
}

/**
 * Reads and validates the boards file. Never throws: a missing or
 * unparseable file yields an empty config plus a warning, so one bad
 * config file cannot take down the rest of an unattended ingestion run.
 */
export async function loadAtsBoardsConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl: (filePath: string, encoding: "utf8") => Promise<string> = readFile
): Promise<{ config: AtsBoardsConfig; warnings: string[]; filePath: string }> {
  const filePath = defaultAtsBoardsPath(env);

  let text: string;
  try {
    text = await readFileImpl(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const reason = code === "ENOENT" ? "file not found" : error instanceof Error ? error.message : String(error);
    return { config: emptyAtsBoardsConfig(), warnings: [`could not read ${filePath}: ${reason}`], filePath };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      config: emptyAtsBoardsConfig(),
      warnings: [`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      filePath,
    };
  }

  return { ...parseAtsBoardsConfig(json), filePath };
}

// ── Generic per-board adapter ────────────────────────────────────────────

const DEFAULT_BOARD_CONCURRENCY = 4;
const MAX_REPORTED_BOARD_ERRORS = 15;

export interface AtsAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /** Bypasses the config file entirely (used by tests and by callers that already hold a board list). */
  boards?: AtsBoardRef[];
  fetchOptions?: FetchJsonOptions;
  concurrency?: number;
}

export interface BoardAdapterSpec {
  ats: AtsName;
  boardUrl: (slug: string) => string;
  /** Pure parser: raw board JSON → listings + raw job count. Must never throw on odd input. */
  parse: (raw: unknown, board: AtsBoardRef) => { listings: CanonicalListing[]; fetched: number };
}

export function createBoardsAdapter(spec: BoardAdapterSpec, options: AtsAdapterOptions = {}): SourceAdapter {
  const env = options.env ?? process.env;
  const concurrency = options.concurrency ?? DEFAULT_BOARD_CONCURRENCY;

  return {
    sourceName: spec.ats,
    async run(): Promise<AdapterRunResult> {
      const errors: string[] = [];

      let boards = options.boards;
      if (!boards) {
        const loaded = await loadAtsBoardsConfig(env);
        boards = loaded.config[spec.ats];
        for (const warning of loaded.warnings) {
          // Per-ATS warnings are prefixed "<ats>: "; file-level warnings have no prefix and apply to all.
          const prefixed = ATS_NAMES.some((name) => warning.startsWith(`${name}: `));
          if (!prefixed || warning.startsWith(`${spec.ats}: `)) errors.push(`${spec.ats}: ${warning.replace(`${spec.ats}: `, "")}`);
        }
      }

      if (boards.length === 0) {
        errors.push(`${spec.ats}: no company boards configured — skipping (see docs/ingestion-sources.md)`);
        return { sourceName: spec.ats, fetched: 0, keptAfterFilter: 0, listings: [], errors };
      }

      const outcomes = await mapWithConcurrency(boards, concurrency, async (board) => {
        try {
          const raw = await fetchJsonWithRetry(spec.boardUrl(encodeURIComponent(board.slug)), options.fetchOptions);
          return { board, ...spec.parse(raw, board), error: null as string | null };
        } catch (error) {
          const message =
            error instanceof HttpStatusError && error.status === 404
              ? "board not found (check the slug in ats-boards.json)"
              : error instanceof Error
                ? error.message
                : String(error);
          return { board, listings: [] as CanonicalListing[], fetched: 0, error: message };
        }
      });

      let fetched = 0;
      const listings: CanonicalListing[] = [];
      const boardErrors: string[] = [];

      for (const outcome of outcomes) {
        fetched += outcome.fetched;
        listings.push(...outcome.listings);
        if (outcome.error) boardErrors.push(`${spec.ats}/${outcome.board.slug}: ${outcome.error}`);
      }

      errors.push(...boardErrors.slice(0, MAX_REPORTED_BOARD_ERRORS));
      if (boardErrors.length > MAX_REPORTED_BOARD_ERRORS) {
        errors.push(`${spec.ats}: …and ${boardErrors.length - MAX_REPORTED_BOARD_ERRORS} more board errors`);
      }

      return { sourceName: spec.ats, fetched, keptAfterFilter: listings.length, listings, errors };
    },
  };
}
