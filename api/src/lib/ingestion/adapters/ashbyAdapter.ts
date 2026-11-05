// ashbyAdapter.ts
//
// Source: Ashby's public job-board posting API —
//   GET https://api.ashbyhq.com/posting-api/job-board/{board}
// One request returns a company's whole board as { jobs: [...] }; no API
// key, no pagination. The board name is the slug in jobs.ashbyhq.com/{board}.
//
// Field reliability: `id`, `title`, `location`, `jobUrl` and `publishedAt`
// are confirmed by multiple independent public integrations. The remaining
// fields used here (`employmentType`, `workplaceType`, `isRemote`,
// `applyUrl`, `isListed`, `descriptionPlain`) are read defensively — every
// one is optional in the parser's types, so if Ashby renames or drops one,
// that axis degrades to null/"not stated" instead of throwing.
//
// Internship filter: Ashby has a structured employmentType ("Intern" for
// internships), which is used in addition to a title word-match. No
// description scan — see greenhouseAdapter.ts for the reasoning.
// Unlisted postings (isListed === false) are skipped.

import { cleanLine, toIsoDate } from "../normalize.js";
import type { CanonicalListing, SourceAdapter } from "../types.js";
import {
  buildAtsListing,
  createBoardsAdapter,
  plainToBoundedText,
  titleSignalsInternship,
  workModeFromLocationText,
  type AtsAdapterOptions,
  type AtsBoardRef,
} from "./adapterCommon.js";

const SOURCE_NAME = "ashby";

interface AshbyRawJob {
  id?: string;
  title?: string;
  location?: string | null;
  employmentType?: string | null;
  workplaceType?: string | null;
  isRemote?: boolean | null;
  isListed?: boolean | null;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string | null;
  descriptionPlain?: string | null;
}

function mapWorkplaceType(job: AshbyRawJob, location: string | null): CanonicalListing["work_mode"] {
  switch ((job.workplaceType ?? "").toLowerCase().replace(/[\s-]/g, "")) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
      return "onsite";
    default:
      break;
  }
  if (job.isRemote === true) return "remote";
  return workModeFromLocationText(location);
}

/** Pure parser for one Ashby board's response. */
export function parseAshbyListings(
  raw: unknown,
  board: AtsBoardRef
): { listings: CanonicalListing[]; fetched: number } {
  const jobs = (raw as { jobs?: unknown } | null)?.jobs;
  const entries = Array.isArray(jobs) ? (jobs as AshbyRawJob[]) : [];
  const listings: CanonicalListing[] = [];

  for (const job of entries) {
    if (!job || typeof job !== "object" || !job.id) continue;
    if (job.isListed === false) continue;

    const title = cleanLine(job.title ?? null);
    if (!title) continue;

    const isInternship = titleSignalsInternship(title) || (job.employmentType ?? "").toLowerCase() === "intern";
    if (!isInternship) continue;

    const location = cleanLine(job.location ?? null);
    const sourceUrl = job.jobUrl ?? null;

    listings.push(
      buildAtsListing({
        sourceName: SOURCE_NAME,
        sourceRef: `${board.slug}:${job.id}`,
        sourceUrl,
        applicationUrl: job.applyUrl ?? sourceUrl,
        title,
        company: board.company,
        description: plainToBoundedText(job.descriptionPlain),
        location,
        workMode: mapWorkplaceType(job, location),
        postedDate: toIsoDate(job.publishedAt ?? null),
      })
    );
  }

  return { listings, fetched: entries.length };
}

export function createAshbyAdapter(options: AtsAdapterOptions = {}): SourceAdapter {
  return createBoardsAdapter(
    {
      ats: "ashby",
      boardUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      parse: parseAshbyListings,
    },
    options
  );
}
