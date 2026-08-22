// skillNormalization.ts
// Pure application-level skill-name normalization for Opportunity
// Intelligence Phase 1B (matching engine). No database taxonomy exists yet
// — see the Phase 1B audit's "Missing Data" section — this module is the
// stand-in normalization layer the audit called for, kept intentionally
// small and explicit rather than a general taxonomy service.
//
// Used to compare three independently free-text sources that share no
// vocabulary today:
//   - public.skill.name
//   - public.project.tech_stack[]
//   - public.opportunity_source.skills[]
//
// Pure function, no I/O of any kind: no database, no network, no LLM.
// Reusable by any future caller (matching engine, ingestion job,
// scheduler, Discord/WhatsApp distribution) without pulling in Express,
// Supabase, or environment configuration.

/**
 * Small, explicit alias table. Deliberately NOT a general taxonomy —
 * only entries actually called for by the task brief. Keys are the
 * pre-normalization (lowercased, trimmed, punctuation-collapsed) forms
 * that should collapse onto a single canonical value.
 *
 * Extend this table only with concrete, justified aliases — resist the
 * temptation to guess at a broader taxonomy here; that is explicitly a
 * later decision (see the Phase 1B audit, "Missing Data" §D).
 */
const ALIASES: Record<string, string> = {
  "react js": "react",
  reactjs: "react",
  react: "react",

  "node js": "node",
  nodejs: "node",
  node: "node",

  "express js": "express",
  expressjs: "express",
  express: "express",

  postgresql: "postgresql",
  postgres: "postgresql",

  mongodb: "mongodb",
  mongo: "mongodb",
};

/**
 * Normalizes a single raw skill string into a canonical, comparable form.
 *
 * Steps (in order):
 *   1. Lowercase
 *   2. Trim leading/trailing whitespace
 *   3. Collapse common punctuation differences: '.', '-', '_' all become
 *      a single space, then internal whitespace runs are collapsed to one
 *      space (so "Node.js", "Node-js", "Node_js", "Node  js" all reach
 *      the same intermediate form before alias lookup).
 *   4. Alias lookup against the small explicit table above.
 *
 * Returns an empty string for empty/whitespace-only input — callers
 * should filter these out rather than treat "" as a real skill.
 */
export function normalizeSkillName(raw: string): string {
  if (!raw) return "";

  const collapsedPunctuation = raw
    .toLowerCase()
    .trim()
    .replace(/[.\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!collapsedPunctuation) return "";

  return ALIASES[collapsedPunctuation] ?? collapsedPunctuation;
}

/**
 * Normalizes a list of raw skill strings, de-duplicating identical
 * normalized results (so ["React", "react", "ReactJS"] -> ["react"]) and
 * dropping empty results. Order of first occurrence is preserved.
 */
export function normalizeSkillList(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const normalized = normalizeSkillName(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}