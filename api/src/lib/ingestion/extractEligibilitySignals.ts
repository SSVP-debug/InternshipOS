// extractEligibilitySignals.ts
//
// A3.3: deterministic, narrowly-scoped extraction of eligibility signals
// from unstructured source text (title/description). Deliberately the
// ONLY text-extraction rule this milestone adds — every other 0022/0023
// eligibility column (citizenship_required_countries,
// eligible_candidate_countries, required_degree_types, required_majors,
// graduation_not_before/after, required_enrollment_statuses,
// requires_existing_work_authorization) has no comparably reliable,
// low-ambiguity textual signal in either Adzuna or RemoteOK postings
// and is intentionally left NULL by both adapters — see the A3.3
// implementation report for the reasoning per field.
//
// Same discipline as extractSkills.ts (A3.1): plain phrase/regex
// matching, no NLP, no LLM, deterministic given the same input. Applies
// specifically to sponsorship_offered because, unlike the removed
// US-only citizenship phrase parser (see matchEngine.ts's module
// header), "visa sponsorship" is a country-neutral English phrase used
// the same way regardless of which country's jobs market a posting is
// from — it does not reintroduce the country-specific assumption that
// parser was removed for.
//
// Conservative by construction:
//   - Only a bounded, hand-reviewed list of unambiguous phrases in
//     either direction is matched (word-boundary, case-insensitive).
//   - If both a positive and a negative phrase are present in the same
//     text (e.g. boilerplate quoting a policy and then negating it, or
//     two conflicting statements), the result is `null` — a conflicting
//     signal is treated exactly like no signal, never guessed in either
//     direction.
//   - If neither list matches, the result is `null` ("not stated"),
//     never defaulted to true or false.
//   - Under-extraction (a real sponsorship statement this list doesn't
//     happen to cover) is an accepted cost; a false positive — wrongly
//     asserting an employer's sponsorship policy — is not, since
//     matchEngine.ts's sponsorship signal can directly resolve a
//     candidate to `ineligible` (see evaluateSponsorshipSignal), unlike
//     an over-broad skill tag which only inflates a score.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPhraseRegex(phrases: string[]): RegExp {
  const alternation = phrases.map((phrase) => escapeRegExp(phrase).replace(/\s+/g, "\\s+")).join("|");
  return new RegExp(`\\b(?:${alternation})\\b`, "i");
}

// Explicit, unambiguous statements that the employer WILL sponsor a
// work visa. Every phrase requires the word "sponsor" (or "sponsorship")
// combined with "visa" — bare "sponsor"/"sponsorship" alone is excluded
// because postings also use it for unrelated senses (event/scholarship
// sponsorship), which would be a false positive.
const POSITIVE_PHRASES = [
  "visa sponsorship available",
  "offers visa sponsorship",
  "provides visa sponsorship",
  "will sponsor visa",
  "will sponsor a visa",
  "will sponsor work visa",
  "willing to sponsor a visa",
  "willing to sponsor visas",
  "open to sponsoring visas",
  "open to visa sponsorship",
  "we sponsor visas",
  "we sponsor work visas",
];

// Explicit, unambiguous statements that the employer will NOT sponsor a
// work visa. Same "visa" co-occurrence discipline as POSITIVE_PHRASES.
const NEGATIVE_PHRASES = [
  "no visa sponsorship",
  "not offer visa sponsorship",
  "does not offer visa sponsorship",
  "do not offer visa sponsorship",
  "not provide visa sponsorship",
  "does not provide visa sponsorship",
  "unable to sponsor visas",
  "unable to sponsor a visa",
  "unable to provide visa sponsorship",
  "cannot sponsor visas",
  "cannot sponsor a visa",
  "will not sponsor a visa",
  "will not sponsor visas",
  "not able to sponsor visas",
  "not able to sponsor a visa",
  "visa sponsorship is not available",
  "visa sponsorship not available",
  "no sponsorship for visas",
];

const POSITIVE_REGEX = buildPhraseRegex(POSITIVE_PHRASES);
const NEGATIVE_REGEX = buildPhraseRegex(NEGATIVE_PHRASES);

/**
 * Deterministically extracts an opportunity_source.sponsorship_offered
 * tri-state signal from title+description text. Returns `true`/`false`
 * only when exactly one direction's phrase list matches; `null`
 * (unstated/ambiguous) otherwise — including when both lists match the
 * same text, which is treated as conflicting rather than guessed.
 */
export function extractSponsorshipSignal(title: string, description: string | null): boolean | null {
  const text = `${title} ${description ?? ""}`;

  const hasPositive = POSITIVE_REGEX.test(text);
  const hasNegative = NEGATIVE_REGEX.test(text);

  if (hasPositive && hasNegative) return null;
  if (hasPositive) return true;
  if (hasNegative) return false;
  return null;
}
