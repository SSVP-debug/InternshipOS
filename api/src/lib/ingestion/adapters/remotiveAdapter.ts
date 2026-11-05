// remotiveAdapter.ts
//
// Source: Remotive's public remote-jobs API —
//   GET https://remotive.com/api/remote-jobs?search=intern
// Free, no key. Remotive's own terms (github.com/remotive-com/remote-jobs-api)
// ask integrators to: link back to the original posting and credit Remotive
// (every listing keeps Remotive's own page as source_url/application_url,
// and the UI shows that link), NOT resubmit listings to third-party job
// boards (this project only shows them to the candidate), and keep request
// volume low (blocked above roughly 2 requests/minute; the free feed is also
// delayed ~24h). This adapter makes exactly ONE request per run, so it sits
// far below that limit.
//
// The `search` parameter matches title+description case-insensitively
// (partial match), so the response is then re-checked client-side with
// normalize.isInternshipRelevant — same second-filter discipline as the
// Adzuna and RemoteOK adapters. Remotive's feed is returned whole, so there
// is no pagination.
//
// Remote-only by construction → work_mode "remote". Remotive's
// candidate_required_location (e.g. "Worldwide", "USA Only") is kept in
// `location` for display but deliberately NOT mapped to any eligibility
// column — it is a residency preference, not a citizenship/work-authorization
// fact (same reasoning as remoteokAdapter.ts's header).
//
// Field notes (fields used): id, url, title, company_name, category, tags[],
// job_type, publication_date (naive ISO timestamp), candidate_required_location,
// description (HTML).

import { cleanLine, isInternshipRelevant, toIsoDate } from "../normalize.js";
import type { AdapterRunResult, CanonicalListing, SourceAdapter } from "../types.js";
import {
  buildAtsListing,
  fetchJsonWithRetry,
  htmlToBoundedText,
  type FetchJsonOptions,
} from "./adapterCommon.js";

const SOURCE_NAME = "remotive";
const API_URL = "https://remotive.com/api/remote-jobs?search=intern";

interface RemotiveRawJob {
  id?: number | string;
  url?: string;
  title?: string;
  company_name?: string;
  tags?: unknown;
  job_type?: string | null;
  publication_date?: string | null;
  candidate_required_location?: string | null;
  description?: string | null;
}

/** Pure parser for the Remotive response envelope ({ "job-count", jobs: [...] }). */
export function parseRemotiveListings(raw: unknown): { listings: CanonicalListing[]; fetched: number } {
  const jobs = (raw as { jobs?: unknown } | null)?.jobs;
  const entries = Array.isArray(jobs) ? (jobs as RemotiveRawJob[]) : [];
  const listings: CanonicalListing[] = [];

  for (const job of entries) {
    if (!job || typeof job !== "object" || job.id === undefined || job.id === null) continue;

    const title = cleanLine(job.title ?? null);
    const company = cleanLine(job.company_name ?? null);
    if (!title || !company) continue;

    const description = htmlToBoundedText(job.description);
    const isInternship = isInternshipRelevant(title, description) || (job.job_type ?? "").toLowerCase() === "internship";
    if (!isInternship) continue;

    const tags = Array.isArray(job.tags) ? job.tags.filter((tag): tag is string => typeof tag === "string") : [];

    listings.push(
      buildAtsListing({
        sourceName: SOURCE_NAME,
        sourceRef: String(job.id),
        sourceUrl: job.url ?? null,
        applicationUrl: job.url ?? null,
        title,
        company,
        description,
        location: cleanLine(job.candidate_required_location ?? null) ?? "Remote",
        workMode: "remote",
        postedDate: toIsoDate(job.publication_date ?? null),
        sourceSkills: tags,
      })
    );
  }

  return { listings, fetched: entries.length };
}

export function createRemotiveAdapter(fetchOptions: FetchJsonOptions = {}): SourceAdapter {
  return {
    sourceName: SOURCE_NAME,
    async run(): Promise<AdapterRunResult> {
      const errors: string[] = [];
      try {
        const raw = await fetchJsonWithRetry(API_URL, fetchOptions);
        const { listings, fetched } = parseRemotiveListings(raw);
        return { sourceName: SOURCE_NAME, fetched, keptAfterFilter: listings.length, listings, errors };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return { sourceName: SOURCE_NAME, fetched: 0, keptAfterFilter: 0, listings: [], errors };
      }
    },
  };
}
