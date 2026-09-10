// urlValidation.ts
//
// A3.3.3 — Source Quality: ingested application_url/source_url values are
// passed straight through from each adapter's raw API response
// (adzunaAdapter.ts's `result.redirect_url`, remoteokAdapter.ts's
// `job.apply_url ?? job.url`) with zero validation today. This module
// adds a purely syntactic well-formedness check — no network access, no
// liveness/reachability check (explicitly out of scope per the A3.3
// design review: "no network-dependent link checking").
//
// Deliberately conservative in what it checks: a successful `new URL()`
// parse plus an http/https scheme. It does NOT attempt to detect a dead
// link, a redirect chain, or a low-quality domain — those all require a
// network round trip this module intentionally never makes.

/**
 * True only for a string that parses as a URL with an http/https scheme.
 * `null`/`undefined`/empty-string/malformed input all return false —
 * callers are expected to coerce a false result to `null` (see
 * coerceToWellFormedUrl below), never to throw or reject the row it came
 * from wholesale.
 */
export function isWellFormedUrl(value: string | null | undefined): boolean {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Returns the input unchanged when it's a well-formed http/https URL,
 * otherwise `null`. This is the coercion the A3.3 design review settled
 * on: a malformed URL on one field must never invalidate the rest of an
 * otherwise-good listing (title, company, skills are all still useful),
 * so ingestion stores `null` for that field rather than rejecting the
 * whole row — the same "null means unstated, never a hard failure"
 * discipline already used for sponsorship_offered and the 0023
 * eligibility columns.
 */
export function coerceToWellFormedUrl(value: string | null | undefined): string | null {
  return isWellFormedUrl(value) ? (value as string) : null;
}
