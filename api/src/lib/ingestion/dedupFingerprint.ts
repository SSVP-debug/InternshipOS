// dedupFingerprint.ts
//
// Computes public.opportunity_source.dedup_fingerprint (unique, not null —
// see 0022_opportunity_intelligence_foundation.sql). Deliberately scoped
// to per-source idempotency, not cross-source entity resolution: the
// same real-world posting appearing on both Adzuna and RemoteOK will
// currently produce two separate opportunity_source rows. Merging those
// is a genuine, hard problem (fuzzy title/company matching) and is out
// of scope for this ingestion milestone — flagged here rather than
// silently attempted.
//
// Fingerprint = sha256("${sourceName}|${sourceRef}"), where sourceRef is
// the source's own native, stable id for the posting. This makes
// re-running ingestion idempotent: the same posting from the same
// source always maps to the same fingerprint, so writeOpportunitySource
// can upsert on conflict instead of inserting a duplicate every run.

import { createHash } from "node:crypto";

export function computeDedupFingerprint(sourceName: string, sourceRef: string): string {
  const normalizedSourceName = sourceName.trim().toLowerCase();
  const normalizedSourceRef = sourceRef.trim();
  return createHash("sha256").update(`${normalizedSourceName}|${normalizedSourceRef}`).digest("hex");
}
