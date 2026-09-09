// remoteokAdapter.ts
//
// Source #2 (international/remote secondary market): RemoteOK's official
// public JSON feed — https://remoteok.com/api. No API key, no
// authentication, free for non-commercial use per RemoteOK's own docs.
// Filtered server-side with ?tag=internship, then re-checked client-side
// by normalize.isInternshipRelevant (the tag alone isn't a hard
// guarantee every result is actually an internship).
//
// KNOWN RESPONSE QUIRK (documented across every third-party client of
// this API): the first element of the returned array is a legal/notice
// object with no `id`/`position`/`company` fields, not a real job. It is
// filtered out below by requiring those fields to be present, rather
// than by assuming it's always exactly index 0 — more robust if RemoteOK
// ever adds a second non-job element.
//
// This adapter is remote-only by construction (RemoteOK only lists
// remote roles), so work_mode is always "remote" — never inferred from
// free text the way the Adzuna adapter has to.
//
// A3.3 eligibility fields:
//   - jurisdiction_country is left null, deliberately, unlike Adzuna.
//     "Remote" does not imply a single jurisdiction — RemoteOK is a
//     global feed with no per-run country scoping the way Adzuna's
//     COUNTRY constant provides, so there is no equivalent structural
//     signal here. RemoteOK's own `location` field (e.g. "Worldwide",
//     "USA Only", "Europe") is source-provided but describes a
//     residency/timezone preference, not a citizenship or
//     work-authorization jurisdiction fact — mapping it onto
//     jurisdiction_country or eligible_candidate_countries would
//     conflate "must be located in" with "must be a citizen of", which
//     the country-neutral eligibility columns don't ask for and the
//     conservatism rule in the A3.3 brief specifically warns against
//     inventing. Left null; see the A3.3 implementation report.
//   - sponsorship_offered is extracted from title+description via the
//     same narrow, bounded phrase list Adzuna uses — see
//     extractEligibilitySignals.ts.
//   - Every other eligibility column has no comparably reliable signal
//     in RemoteOK's response and is left null.

import { cleanLine, cleanText, isInternshipRelevant, toIsoDate } from "../normalize.js";
import type { AdapterRunResult, CanonicalListing, SourceAdapter } from "../types.js";
import { normalizeSkillList } from "../../skillNormalization.js";
import { extractSponsorshipSignal } from "../extractEligibilitySignals.js";

const SOURCE_NAME = "remoteok";
const API_URL = "https://remoteok.com/api?tag=internship";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 10_000;

/** Raw shape of one job entry from the RemoteOK feed (fields this adapter uses only). */
interface RemoteOkRawJob {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  description?: string;
  tags?: string[];
  location?: string;
  url?: string;
  apply_url?: string;
  date?: string; // ISO timestamp
  epoch?: number; // unix seconds, fallback if `date` is absent
}

async function fetchWithRetry(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // RemoteOK's docs note some clients get blocked without a UA header.
          "User-Agent": "InternshipOS-Ingestion/0.1 (+https://github.com/internshipos)",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`RemoteOK responded with HTTP ${response.status}`);
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

/**
 * Parses the raw RemoteOK feed array into CanonicalListing[]. Pure
 * (given the already-fetched JSON), no network — this is what's
 * exercised directly by tests against saved fixtures.
 *
 * `fetched` is the raw entry count (including the legal-notice object
 * and any malformed entries) — a diagnostic of what the API returned,
 * not what passed filtering. `listings.length` is the true "kept after
 * filter" count.
 */
export function parseRemoteOkListings(raw: unknown): { listings: CanonicalListing[]; fetched: number } {
  const entries = Array.isArray(raw) ? raw : [];

  // Real job entries always have id, position, and company. The leading
  // legal-notice object (and any malformed entry) lacks at least one of
  // these and is dropped here.
  const jobs = entries.filter(
    (entry): entry is RemoteOkRawJob =>
      !!entry &&
      typeof entry === "object" &&
      "id" in entry &&
      "position" in entry &&
      "company" in entry &&
      Boolean((entry as RemoteOkRawJob).id) &&
      Boolean((entry as RemoteOkRawJob).position) &&
      Boolean((entry as RemoteOkRawJob).company)
  );

  const listings: CanonicalListing[] = [];

  for (const job of jobs) {
    const title = cleanLine(job.position ?? null);
    const company = cleanLine(job.company ?? null);
    if (!title || !company) continue;

    const description = cleanText(job.description ?? null);
    if (!isInternshipRelevant(title, description)) continue;

    const sourceRef = String(job.id);
    const applicationUrl = job.apply_url ?? job.url ?? null;
    const postedDate = job.date ? toIsoDate(job.date) : job.epoch ? toIsoDate(job.epoch) : null;

    listings.push({
      source_type: "job_board",
      source_name: SOURCE_NAME,
      source_ref: sourceRef,
      source_url: applicationUrl,
      title,
      company,
      description,
      location: cleanLine(job.location ?? null) ?? "Remote",
      work_mode: "remote",
      employment_type: "internship",
      skills: normalizeSkillList(job.tags ?? []),
      application_url: applicationUrl,
      deadline_date: null, // RemoteOK does not publish deadlines
      posted_date: postedDate,

      // A3.3 — see module header for the reasoning behind each field.
      sponsorship_offered: extractSponsorshipSignal(title, description),
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
    });
  }

  return { listings, fetched: entries.length };
}

export function createRemoteOkAdapter(): SourceAdapter {
  return {
    sourceName: SOURCE_NAME,
    async run(): Promise<AdapterRunResult> {
      const errors: string[] = [];

      try {
        const raw = await fetchWithRetry(API_URL);
        const { listings, fetched } = parseRemoteOkListings(raw);
        return { sourceName: SOURCE_NAME, fetched, keptAfterFilter: listings.length, listings, errors };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return { sourceName: SOURCE_NAME, fetched: 0, keptAfterFilter: 0, listings: [], errors };
      }
    },
  };
}
