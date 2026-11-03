// leverPostingsAdapter.ts
//
// Source: Lever's public Postings API (read-only) —
//   GET https://api.lever.co/v0/postings/{site}?mode=json
// The response is a bare JSON array (not an object) of every published
// posting for one company site. Read access is public and keyless — the
// same GET endpoint ats/leverAdapter.ts's getLeverPosting() already relies
// on. Only *submitting* an application needs an employer-issued key, and
// this adapter never submits anything.
//
// Named leverPostingsAdapter.ts (not leverAdapter.ts) because
// api/src/lib/ats/leverAdapter.ts already exists for the single-posting
// lookup/submission path; this file is the bulk *ingestion* side.
//
// Limitations: Lever sites hosted in the EU region use a different API host
// (api.eu.lever.co) and are not covered; add a region field to the board
// config if that is ever needed. A bad site slug returns HTTP 404, which is
// reported as a per-board error and never aborts the other boards.
//
// Internship filter: title word-match OR Lever's structured
// categories.commitment containing "intern" (e.g. "Intern", "Internship").
// No description scan — see greenhouseAdapter.ts for the reasoning.
//
// Field notes (fields used): id, text (title), hostedUrl, applyUrl,
// createdAt (epoch MILLISECONDS), categories.location / .commitment,
// workplaceType ("remote" | "hybrid" | "onsite" | "unspecified"),
// descriptionPlain.

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

const SOURCE_NAME = "lever";

interface LeverRawPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  categories?: { location?: string | null; commitment?: string | null } | null;
  workplaceType?: string | null;
  descriptionPlain?: string | null;
}

function mapWorkplaceType(value: string | null | undefined): CanonicalListing["work_mode"] {
  switch ((value ?? "").toLowerCase().replace(/[\s-]/g, "")) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
      return "onsite";
    default:
      return null; // "unspecified" or absent → not stated
  }
}

/** Pure parser for one Lever site's response (a bare array). */
export function parseLeverListings(
  raw: unknown,
  board: AtsBoardRef
): { listings: CanonicalListing[]; fetched: number } {
  const entries = Array.isArray(raw) ? (raw as LeverRawPosting[]) : [];
  const listings: CanonicalListing[] = [];

  for (const posting of entries) {
    if (!posting || typeof posting !== "object" || !posting.id) continue;

    const title = cleanLine(posting.text ?? null);
    if (!title) continue;

    const commitment = cleanLine(posting.categories?.commitment ?? null);
    const isInternship = titleSignalsInternship(title) || (commitment !== null && /\bintern/i.test(commitment));
    if (!isInternship) continue;

    const location = cleanLine(posting.categories?.location ?? null);
    const workMode = mapWorkplaceType(posting.workplaceType) ?? workModeFromLocationText(location);

    listings.push(
      buildAtsListing({
        sourceName: SOURCE_NAME,
        sourceRef: `${board.slug}:${posting.id}`,
        sourceUrl: posting.hostedUrl ?? null,
        applicationUrl: posting.applyUrl ?? posting.hostedUrl ?? null,
        title,
        company: board.company,
        description: plainToBoundedText(posting.descriptionPlain),
        location,
        workMode,
        // Lever's createdAt is epoch milliseconds; toIsoDate expects seconds.
        postedDate: typeof posting.createdAt === "number" ? toIsoDate(Math.floor(posting.createdAt / 1000)) : null,
      })
    );
  }

  return { listings, fetched: entries.length };
}

export function createLeverPostingsAdapter(options: AtsAdapterOptions = {}): SourceAdapter {
  return createBoardsAdapter(
    {
      ats: "lever",
      boardUrl: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
      parse: parseLeverListings,
    },
    options
  );
}
