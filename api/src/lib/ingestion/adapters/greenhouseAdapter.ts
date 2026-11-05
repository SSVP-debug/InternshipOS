// greenhouseAdapter.ts
//
// Source: Greenhouse's public Job Board API —
//   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
// Read access needs no API key (only *applying* does, which this project
// never does — see PROGRESS.md's 2026-09-19 correction). The board token is
// the slug in a company's careers URL (boards.greenhouse.io/{token} or
// job-boards.greenhouse.io/{token}).
//
// One request returns a company's whole board, so there is no pagination;
// "every available result" simply means every configured board, read in
// full. Which companies to read is configuration, not code: see
// api/config/ats-boards.json and docs/ingestion-sources.md.
//
// Internship filter — deliberately STRICTER than the Adzuna/RemoteOK
// adapters: the title alone must signal an internship. Those adapters also
// accept a description match because their search queries are already
// scoped to internships. A company board is not scoped at all, and a
// description scan would admit every full-time role whose boilerplate
// mentions "our internship program". A real internship nearly always says
// so in its title; under-matching is the accepted cost, consistent with
// extractSkills.ts's conservative posture.
//
// Field notes (Greenhouse response, fields this adapter uses):
//   id, title, location.name, absolute_url, first_published, updated_at,
//   content (HTML, entity-escaped — decoded before tag-stripping).
// Greenhouse returns no company name, so each board's display name comes
// from the config file. `location.name` often holds only a work mode or a
// city; work_mode is set only from an explicit "Remote"/"Hybrid" word.

import { cleanLine, toIsoDate } from "../normalize.js";
import type { CanonicalListing, SourceAdapter } from "../types.js";
import {
  buildAtsListing,
  createBoardsAdapter,
  htmlToBoundedText,
  titleSignalsInternship,
  workModeFromLocationText,
  type AtsAdapterOptions,
  type AtsBoardRef,
} from "./adapterCommon.js";

const SOURCE_NAME = "greenhouse";

interface GreenhouseRawJob {
  id?: number | string;
  title?: string;
  location?: { name?: string | null } | null;
  absolute_url?: string;
  first_published?: string | null;
  updated_at?: string | null;
  content?: string | null;
}

/**
 * Parses one board's response into CanonicalListing[]. Pure (no network):
 * exercised directly by tests against saved fixtures. `fetched` is the raw
 * job count for the board, before the internship filter.
 */
export function parseGreenhouseListings(
  raw: unknown,
  board: AtsBoardRef
): { listings: CanonicalListing[]; fetched: number } {
  const jobs = (raw as { jobs?: unknown } | null)?.jobs;
  const entries = Array.isArray(jobs) ? (jobs as GreenhouseRawJob[]) : [];

  const listings: CanonicalListing[] = [];

  for (const job of entries) {
    if (!job || typeof job !== "object" || job.id === undefined || job.id === null) continue;

    const title = cleanLine(job.title ?? null);
    if (!title || !titleSignalsInternship(title)) continue;

    const location = cleanLine(job.location?.name ?? null);
    const url = job.absolute_url ?? null;

    listings.push(
      buildAtsListing({
        sourceName: SOURCE_NAME,
        sourceRef: `${board.slug}:${job.id}`,
        sourceUrl: url,
        applicationUrl: url,
        title,
        company: board.company,
        description: htmlToBoundedText(job.content),
        location,
        workMode: workModeFromLocationText(location),
        postedDate: toIsoDate(job.first_published ?? job.updated_at ?? null),
      })
    );
  }

  return { listings, fetched: entries.length };
}

export function createGreenhouseAdapter(options: AtsAdapterOptions = {}): SourceAdapter {
  return createBoardsAdapter(
    {
      ats: "greenhouse",
      boardUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      parse: parseGreenhouseListings,
    },
    options
  );
}
