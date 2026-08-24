// normalize.ts (ingestion)
//
// Pure, source-agnostic normalization helpers shared by every adapter.
// No I/O, no adapter-specific field mapping — that stays in each
// adapter, since Adzuna and RemoteOK don't share a response shape.
// What IS shared: the internship-relevance filter, text cleanup, and
// date coercion, so both adapters apply the same rules the same way.

/**
 * True if the title or description clearly signals an internship/co-op
 * posting. Uses a word-boundary match so "internship"/"interns"/"intern"
 * match but "international" and "internet" do not (both contain "intern"
 * as a substring but not as a whole word).
 *
 * Both source queries are already scoped toward internships (Adzuna's
 * `what=internship` search term, RemoteOK's `intern` tag), but neither
 * guarantees every result is actually an internship — this is a second,
 * independent check before a listing is written to opportunity_source.
 */
const INTERNSHIP_WORD = /\bintern(?:s|ship|ships)?\b/i;

export function isInternshipRelevant(title: string, description: string | null): boolean {
  if (INTERNSHIP_WORD.test(title)) return true;
  if (description && INTERNSHIP_WORD.test(description)) return true;
  return false;
}

/**
 * Strips HTML tags and collapses whitespace. Both source APIs return
 * HTML-flavored description text (Adzuna: full_description with markup;
 * RemoteOK: description with markup) with no structured plaintext
 * alternative — this is a plain tag-strip, not an HTML sanitizer, and
 * must never be used to render trusted HTML.
 */
export function cleanText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : null;
}

/** Trims and collapses internal whitespace; returns null for empty input. */
export function cleanLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerces a source date value (ISO 8601 timestamp, unix epoch seconds,
 * or already-a-date string) to a YYYY-MM-DD date-only string, or null if
 * it can't be parsed. opportunity_source.posted_date/deadline_date are
 * `date` columns, not `timestamptz` — this must not carry a time
 * component through.
 */
export function toIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;

  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);

  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}
