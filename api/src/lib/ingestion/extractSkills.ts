// extractSkills.ts
//
// A3.1: deterministic, word-boundary keyword extraction for opportunity
// sources that don't supply a structured skills field. Today that's
// Adzuna only — RemoteOK already provides real skill data via `tags`
// (see remoteokAdapter.ts, which never calls this module).
//
// Same "small, explicit, justified — not a general taxonomy" discipline
// as skillNormalization.ts's ALIASES table (this module's sibling
// design precedent, referenced throughout the A3.1 design audit). This
// is plain keyword/regex matching — no NLP, no LLM, no network I/O, no
// randomness. Given the same title/description twice, it always returns
// the same result.
//
// Deliberately conservative: every short/ambiguous term flagged in the
// A3.1 design audit and correction passes (R, C, Go, Spring, AI, Swift,
// Rust, Node) is either excluded entirely or requires a longer,
// unambiguous surface form (e.g. "spring boot" instead of bare
// "spring", which collides too often with ordinary internship-posting
// boilerplate like "Spring 2026 internship"). Under-extraction (missing
// a real skill mention) is an accepted cost; a false-positive is not,
// since a wrongly "detected" skill would silently distort match scoring
// (matchEngine.ts's computeSkillsAndProjects treats every entry in
// `skills` as real evidence — see that file's own comments).
//
// Detection only. This module does NOT do alias equivalence (e.g.
// "react.js" vs "reactjs" vs "react" collapsing to one value) — that
// remains skillNormalization.ts's job. The adapter that calls this
// module is expected to pipe the result through normalizeSkillList()
// immediately afterward, exactly as remoteokAdapter.ts already does for
// its own (source-supplied) skill tags — no special-casing between how
// the two sources' skill data is normalized, only how it's discovered.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Vocabulary ───────────────────────────────────────────────────────
// Bounded, grouped, and scoped to what's plausible in an internship
// posting — not a general skills database (per the A3.1 design brief).
// Extend only with terms justified by real observed description text,
// the same discipline skillNormalization.ts's own ALIASES table follows.
//
// Matched case-insensitively, word-boundary-only, against text that has
// already had '.', '-', '_', '/' collapsed to spaces (see
// buildSearchText below) — so "Node.js", "Node-js", "CI/CD" etc. are all
// matched in their collapsed form, one level up from this list.
const SINGLE_WORD_TERMS: string[] = [
  // Programming languages
  // NOTE: bare "r" and "c" are deliberately excluded (see
  // PUNCTUATION_SENSITIVE_TERMS for "c++"/"c#") — single-letter terms
  // are far too likely to collide with ordinary text to extract safely.
  // Bare "go", "swift", and "rust" are also excluded for the same
  // reason ("go" is an extremely common English verb; "swift" is a
  // common English adjective; "rust" is a common English noun for metal
  // oxidation, plausible in ordinary posting text) — "golang" is
  // included below as the unambiguous form of Go. Rust has no
  // comparably common unambiguous compound form, so it is simply
  // excluded rather than offered under an alternate spelling.
  "python", "java", "javascript", "typescript", "ruby", "php", "kotlin", "scala", "golang",
  // Frontend
  "react", "angular", "vue", "html", "css", "redux",
  // Backend
  // NOTE: bare "spring" is deliberately excluded — "Spring 2026
  // internship" / "spring semester" are extremely common phrases in
  // real internship postings. Only the unambiguous "spring boot" form
  // (in PHRASE_TERMS below) is matched. Bare "node" is deliberately
  // excluded too, for the same reason "go" is: it's a common, generic
  // CS/networking term with no connection to Node.js at all ("cluster
  // node", "worker node", "master node", "tree node" — all plausible in
  // ordinary internship-posting text, especially cloud/distributed-
  // systems or data-structures-flavored roles). Only the unambiguous
  // "nodejs" (SINGLE_WORD_TERMS below) and "node js" (PHRASE_TERMS
  // below, matching "Node.js"/"Node-js"/"Node_js" after punctuation
  // collapse) forms are matched — same "golang instead of bare go"
  // pattern. skillNormalization.ts's ALIASES table already collapses
  // both of these onto the same canonical "node" value downstream, so
  // this change affects only what raw string extraction reports, not
  // what the final persisted skill looks like.
  "express", "django", "flask", "rails", "nodejs",
  // Databases
  "sql", "mysql", "postgresql", "mongodb", "sqlite", "redis", "firebase",
  // Cloud/DevOps
  "aws", "azure", "docker", "kubernetes", "git", "github", "jenkins", "terraform", "linux",
  // Data/ML
  "pandas", "numpy", "tensorflow", "pytorch", "tableau",
  // Mobile
  "android", "flutter",
  // Tooling
  "jira", "figma", "postman", "graphql",
];

// Multi-word phrases, matched as a literal space-separated sequence —
// never decomposed into their individual words. Matched in singular
// form only — a plural mention (e.g. "REST APIs") will not match "rest
// api" — extending to plural forms is a deliberate simplification, not
// an oversight; it would meaningfully expand the pattern surface for
// each of these terms for a modest recall gain that hasn't been shown
// to matter yet (see the A3.1 implementation report's "Out of Scope
// Findings").
const PHRASE_TERMS: string[] = [
  "machine learning",
  "deep learning",
  "data analysis",
  "scikit learn",
  "power bi",
  "rest api",
  "ci cd",
  "spring boot", // the only accepted form of "spring" — see note above
  "node js", // matches "Node.js"/"Node-js"/"Node_js" post-collapse — the only accepted phrase form of "node" — see note above ("nodejs", no punctuation, is matched separately in SINGLE_WORD_TERMS)
  "react native", // matched in addition to (not instead of) bare "react" — a React Native listing is a real, unambiguous signal for both, not a false positive requiring exclusion the way spring/go/node's bare forms did
];

// Terms whose distinguishing character is exactly the punctuation that
// buildSearchText() collapses away for the general terms above, so they
// need their own regex against a non-collapsed (but still lowercased)
// copy of the text. Each pattern requires a non-alphanumeric boundary
// (or string start/end) on both sides, since '+', '#', and a leading
// '.' aren't \w characters and \b doesn't behave usefully next to them.
const PUNCTUATION_SENSITIVE_TERMS: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: "c++", pattern: /(^|[^a-z0-9])c\+\+([^a-z0-9]|$)/ },
  { canonical: "c#", pattern: /(^|[^a-z0-9])c#([^a-z0-9]|$)/ },
  { canonical: ".net", pattern: /(^|[^a-z0-9])\.net([^a-z0-9]|$)/ },
];

// "AI" per the design audit: require the literal uppercase form in the
// ORIGINAL (un-lowercased) text — lowercase "ai" is far too likely to
// be a false hit (part of another word, or a stray two-letter
// coincidence) to accept without this extra guard.
const AI_UPPERCASE_PATTERN = /(^|[^A-Za-z])AI([^A-Za-z]|$)/;

function buildSearchText(title: string, description: string | null): string {
  return `${title} ${description ?? ""}`
    .toLowerCase()
    .replace(/[.\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts a conservative list of skill mentions from an opportunity's
 * title + description. Pure, deterministic, no I/O — the same input
 * always produces the same output, including the same order (vocabulary
 * order, not text-occurrence order — matchEngine.ts's scoring treats
 * `skills` as a set, so order carries no scoring meaning either way).
 * Returns raw (lowercase, un-aliased) canonical term strings — callers
 * should pass the result through skillNormalization.ts's
 * normalizeSkillList() before persisting, same as every other skill
 * source in this codebase.
 *
 * Only title and description ever participate — company/location are
 * deliberately not accepted as parameters at all, since a company or
 * city name could coincidentally contain a skill-like substring (e.g. a
 * company literally named "Go Digital").
 */
export function extractSkillsFromText(title: string, description: string | null): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (term: string) => {
    if (!seen.has(term)) {
      seen.add(term);
      found.push(term);
    }
  };

  const collapsed = buildSearchText(title, description);

  for (const term of SINGLE_WORD_TERMS) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(collapsed)) push(term);
  }

  for (const term of PHRASE_TERMS) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(collapsed)) push(term);
  }

  const loweredUncollapsed = `${title} ${description ?? ""}`.toLowerCase();
  for (const { canonical, pattern } of PUNCTUATION_SENSITIVE_TERMS) {
    if (pattern.test(loweredUncollapsed)) push(canonical);
  }

  const rawText = `${title} ${description ?? ""}`;
  if (AI_UPPERCASE_PATTERN.test(rawText)) push("ai");

  return found;
}
