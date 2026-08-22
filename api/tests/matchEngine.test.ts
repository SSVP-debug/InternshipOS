import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchCandidate,
  type CandidateMatchInput,
  type OpportunityMatchInput,
} from "../src/lib/matchEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function candidate(overrides: Partial<CandidateMatchInput> = {}): CandidateMatchInput {
  return {
    skills: [],
    education: [],
    experience: [],
    projects: [],
    workAuthorization: null,
    ...overrides,
  };
}

function opportunity(overrides: Partial<OpportunityMatchInput> = {}): OpportunityMatchInput {
  return {
    employmentType: "internship",
    skills: [],
    sponsorshipOffered: null,
    citizenshipRequirement: null,
    deadlineDate: null,
    ...overrides,
  };
}

// ── Test 1 & 2: alias equivalence flows through into matching (not just
// the normalization module in isolation) ──────────────────────────────

describe("matchCandidate — skill alias equivalence", () => {
  it("Test 1: React.js == ReactJS == React count as a single matched skill", () => {
    const cand = candidate({ skills: [{ name: "ReactJS" }] });
    const opp = opportunity({ skills: ["React.js"] });
    const result = matchCandidate(cand, opp);
    expect(result.missing).not.toContain("react");
    expect(result.reasons).toContain("Matches react");
    expect(result.breakdown.skills).toBe(45); // 1/1 opportunity skill matched, full skills weight
  });

  it("Test 2: Node.js == NodeJS == Node count as a single matched skill", () => {
    const cand = candidate({ skills: [{ name: "Node" }] });
    const opp = opportunity({ skills: ["NodeJS"] });
    const result = matchCandidate(cand, opp);
    expect(result.reasons).toContain("Matches node");
    expect(result.breakdown.skills).toBe(45);
  });
});

// ── Test 3: no double-counting across skill table + project tech_stack ──

describe("matchCandidate — no double counting between skills and projects", () => {
  it("Test 3: a skill present in both skill.name and project.tech_stack is credited once, under skills", () => {
    const cand = candidate({
      skills: [{ name: "React" }],
      projects: [{ techStack: ["React", "GraphQL"] }],
    });
    const opp = opportunity({ skills: ["React", "GraphQL"] });
    const result = matchCandidate(cand, opp);

    // "react" matched via skills (declared skill list) — full credit there.
    // "graphql" matched via projects only (not declared as a skill).
    expect(result.breakdown.skills).toBe(23); // round(45 * 1/2)
    expect(result.breakdown.projects).toBe(8); // round(15 * 1/2)
    expect(result.reasons).toContain("Matches react");
    expect(result.reasons).toContain("Matches graphql (via project experience)");
    // "react" must not appear twice in reasons (once per credit source).
    expect(result.reasons.filter((r) => r.includes("react")).length).toBe(1);
  });
});

// ── Test 4: no work_authorization row → eligibility unknown ─────────────

describe("matchCandidate — eligibility: missing work authorization", () => {
  it("Test 4: candidate.workAuthorization === null yields eligibility 'unknown'", () => {
    const cand = candidate({ workAuthorization: null });
    const opp = opportunity({ sponsorshipOffered: true });
    const result = matchCandidate(cand, opp);
    expect(result.eligibility).toBe("unknown");
    expect(result.unknown).toContain("Work authorization not provided");
  });
});

// ── Test 5: sponsorship_offered NULL → unknown, never coerced to false ──

describe("matchCandidate — eligibility: sponsorship_offered NULL", () => {
  it("Test 5: NULL sponsorship_offered with a candidate who requires sponsorship yields 'unknown', not 'ineligible'", () => {
    const cand = candidate({
      workAuthorization: { status: "needs_sponsorship", requiresSponsorship: true },
    });
    const opp = opportunity({ sponsorshipOffered: null });
    const result = matchCandidate(cand, opp);
    expect(result.eligibility).toBe("unknown");
    expect(result.eligibility).not.toBe("ineligible");
    expect(result.unknown).toContain("Sponsorship requirement not specified by this opportunity");
  });
});

// ── Test 6: a clear sponsorship conflict → ineligible ────────────────────

describe("matchCandidate — eligibility: clear sponsorship conflict", () => {
  it("Test 6: requiresSponsorship=true and sponsorshipOffered=false yields 'ineligible'", () => {
    const cand = candidate({
      workAuthorization: { status: "needs_sponsorship", requiresSponsorship: true },
    });
    const opp = opportunity({ sponsorshipOffered: false });
    const result = matchCandidate(cand, opp);
    expect(result.eligibility).toBe("ineligible");
    expect(result.missing).toContain(
      "Requires employer sponsorship; this opportunity does not offer sponsorship"
    );
  });

  it("does not require sponsorship → eligible regardless of the opportunity's sponsorship field", () => {
    const cand = candidate({
      workAuthorization: { status: "us_citizen", requiresSponsorship: false },
    });
    const opp = opportunity({ sponsorshipOffered: null });
    const result = matchCandidate(cand, opp);
    expect(result.eligibility).toBe("eligible");
  });

  it("explicit U.S.-citizens-only requirement conflicting with candidate status → ineligible", () => {
    const cand = candidate({
      workAuthorization: { status: "h1b", requiresSponsorship: false },
    });
    const opp = opportunity({ citizenshipRequirement: "Must be a U.S. citizen; only citizens will be considered" });
    const result = matchCandidate(cand, opp);
    expect(result.eligibility).toBe("ineligible");
  });

  it("ambiguous citizenship requirement text is reported as unknown, not guessed at", () => {
    const cand = candidate({
      workAuthorization: { status: "h1b", requiresSponsorship: false },
    });
    const opp = opportunity({ citizenshipRequirement: "Must be authorized to work in accordance with export control regulations" });
    const result = matchCandidate(cand, opp);
    expect(result.eligibility).toBe("unknown");
    expect(result.unknown).toContain("Citizenship requirement stated but not automatically verifiable in v1");
  });
});

// ── Test 7: matching skills increase score ────────────────────────────────

describe("matchCandidate — matching skills increase score", () => {
  it("Test 7: more matched skills yields a strictly higher score than fewer, all else equal", () => {
    const opp = opportunity({ skills: ["React", "Node", "PostgreSQL"] });
    const oneMatch = matchCandidate(candidate({ skills: [{ name: "React" }] }), opp);
    const threeMatches = matchCandidate(
      candidate({ skills: [{ name: "React" }, { name: "Node" }, { name: "Postgres" }] }),
      opp
    );
    expect(threeMatches.score).toBeGreaterThan(oneMatch.score);
    expect(threeMatches.breakdown.skills).toBe(45);
    expect(oneMatch.breakdown.skills).toBe(15); // round(45 * 1/3)
  });
});

// ── Test 8: missing skills appear in missing[] ────────────────────────────

describe("matchCandidate — missing skills reporting", () => {
  it("Test 8: an opportunity skill with no candidate coverage appears in missing[]", () => {
    const cand = candidate({ skills: [{ name: "React" }] });
    const opp = opportunity({ skills: ["React", "PostgreSQL"] });
    const result = matchCandidate(cand, opp);
    expect(result.missing).toContain("postgresql");
    expect(result.reasons).toContain("Matches react");
  });
});

// ── Test 9: determinism ───────────────────────────────────────────────────

describe("matchCandidate — determinism", () => {
  it("Test 9: identical inputs produce identical output across repeated calls", () => {
    const cand = candidate({
      skills: [{ name: "React" }, { name: "Node" }],
      education: [
        {
          degreeType: "bachelor",
          major: "Computer Science",
          enrollmentStatus: "current",
          expectedGraduationDate: "2027-05-15",
          isPrimary: true,
        },
      ],
      experience: [{ employmentType: "internship", isCurrent: false }],
      projects: [{ techStack: ["GraphQL"] }],
      workAuthorization: { status: "us_citizen", requiresSponsorship: false },
    });
    const opp = opportunity({
      skills: ["React", "Node", "GraphQL", "Docker"],
      deadlineDate: "2027-01-01",
      sponsorshipOffered: true,
    });

    const first = matchCandidate(cand, opp);
    const second = matchCandidate(cand, opp);
    const third = matchCandidate(cand, opp);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

// ── Test 10 & 11: empty skill lists on either side must not crash ────────

describe("matchCandidate — empty skill lists do not crash", () => {
  it("Test 10: empty opportunity.skills does not crash and yields a well-formed result", () => {
    const cand = candidate({ skills: [{ name: "React" }] });
    const opp = opportunity({ skills: [] });
    const result = matchCandidate(cand, opp);
    expect(result.breakdown.skills).toBe(0);
    expect(result.breakdown.projects).toBe(0);
    // No skills-related entries in missing[] — the "No prior experience
    // listed" entry present here comes from the default empty `experience`
    // array in the candidate() factory, unrelated to the empty-skills case
    // under test.
    expect(result.missing.some((m) => m.includes("react"))).toBe(false);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("Test 11: empty candidate.skills does not crash and yields a well-formed result", () => {
    const cand = candidate({ skills: [] });
    const opp = opportunity({ skills: ["React", "Node"] });
    const result = matchCandidate(cand, opp);
    expect(result.breakdown.skills).toBe(0);
    expect(result.missing).toContain("react");
    expect(result.missing).toContain("node");
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it("handles both candidate and opportunity having entirely empty profiles without crashing", () => {
    const result = matchCandidate(candidate(), opportunity());
    expect(result.score).toBe(0);
    expect(result.eligibility).toBe("unknown");
  });
});

// ── Test 12: PII fields are never accessed by the matcher ────────────────
// Structural guarantee: CandidateMatchInput has no slot for legal name,
// email, phone, or location fields at all, so there is nothing for
// matchCandidate to read even if a caller tried to pass it in (TypeScript
// would reject the extra property on a typed call site). This test
// additionally verifies, at the source level, that neither pure module
// references any personal_info field name or the table itself — a static
// check that the privacy boundary hasn't quietly regressed via a future
// edit that adds a stray column read.

describe("matchCandidate — PII boundary", () => {
  // Strip comments before scanning — this module's own header comments
  // deliberately *document* the personal_info boundary (e.g. "This module
  // never reads public.personal_info"), which would otherwise be a false
  // positive for a naive substring check. We want to catch actual code
  // access (property reads, object literal keys, string args to a query
  // builder), not prose that explains the boundary.
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, incl. JSDoc
      .replace(/\/\/.*$/gm, ""); // line comments
  }

  // Forbidden as CODE identifiers/keys — checked with word boundaries so
  // "email" doesn't false-positive on unrelated identifiers, and checked
  // only against comment-stripped source so documentation prose about the
  // boundary itself doesn't trip the check.
  const FORBIDDEN_CODE_TERMS = [
    "personal_info",
    "legalFirstName",
    "legal_first_name",
    "legalLastName",
    "legal_last_name",
    "email",
    "phone",
    "locationCity",
    "location_city",
    "locationCountry",
    "location_country",
    "pronouns",
  ];

  it("Test 12a: matchEngine.ts has no code-level reference to personal_info or its fields", () => {
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../src/lib/matchEngine.ts"), "utf-8")
    );
    for (const term of FORBIDDEN_CODE_TERMS) {
      const pattern = new RegExp(`\\b${term}\\b`, "i");
      expect(pattern.test(code)).toBe(false);
    }
  });

  it("Test 12b: skillNormalization.ts has no code-level reference to personal_info or its fields", () => {
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../src/lib/skillNormalization.ts"), "utf-8")
    );
    for (const term of FORBIDDEN_CODE_TERMS) {
      const pattern = new RegExp(`\\b${term}\\b`, "i");
      expect(pattern.test(code)).toBe(false);
    }
  });

  it("Test 12c: neither module imports a database/HTTP client, or reads process.env", () => {
    const matchCode = stripComments(
      fs.readFileSync(path.join(__dirname, "../src/lib/matchEngine.ts"), "utf-8")
    );
    const normCode = stripComments(
      fs.readFileSync(path.join(__dirname, "../src/lib/skillNormalization.ts"), "utf-8")
    );
    for (const code of [matchCode, normCode]) {
      expect(code).not.toMatch(/from\s+["']@supabase\/supabase-js["']/);
      expect(code).not.toMatch(/from\s+["']express["']/);
      expect(code).not.toContain("fetch(");
      expect(code).not.toContain("process.env");
    }
  });

  it("Test 12d: CandidateMatchInput has no `skills`/`education`/`experience`/`projects`/`workAuthorization` field that is itself PII — the only string/date leaf fields it exposes are skill names, degree/major/enrollment strings, and work-authorization status/booleans, none of which are drawn from personal_info", () => {
    // Structural/behavioral check: constructing a full CandidateMatchInput
    // and running it through matchCandidate never needs — and the type
    // signature never accepts — a name, email, phone, or location field.
    // This is exercised implicitly by every other test in this file
    // compiling and running without such a field; this test just makes
    // the guarantee explicit and documents it as intentional.
    const cand = candidate({
      skills: [{ name: "React" }],
      education: [
        {
          degreeType: "bachelor",
          major: "CS",
          enrollmentStatus: "current",
          expectedGraduationDate: null,
          isPrimary: true,
        },
      ],
      experience: [{ employmentType: "internship", isCurrent: true }],
      projects: [{ techStack: ["Node"] }],
      workAuthorization: { status: "us_citizen", requiresSponsorship: false },
    });
    const result = matchCandidate(cand, opportunity({ skills: ["React"] }));
    expect(JSON.stringify(result).toLowerCase()).not.toContain("@");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("legal");
  });
});

// ── Additional coverage: education and experience scoring ────────────────

describe("matchCandidate — education scoring", () => {
  it("current student on track to graduate after the deadline gets full education credit", () => {
    const cand = candidate({
      education: [
        {
          degreeType: "bachelor",
          major: "CS",
          enrollmentStatus: "current",
          expectedGraduationDate: "2027-06-01",
          isPrimary: true,
        },
      ],
    });
    const opp = opportunity({ deadlineDate: "2026-12-01" });
    const result = matchCandidate(cand, opp);
    expect(result.breakdown.education).toBe(25);
  });

  it("no education record at all is reported as unknown, not zero-silently", () => {
    const result = matchCandidate(candidate({ education: [] }), opportunity());
    expect(result.unknown).toContain("No education record found");
    expect(result.breakdown.education).toBe(0);
  });

  it("candidate graduating before the opportunity deadline is flagged in missing", () => {
    const cand = candidate({
      education: [
        {
          degreeType: "bachelor",
          major: "CS",
          enrollmentStatus: "current",
          expectedGraduationDate: "2026-01-01",
          isPrimary: true,
        },
      ],
    });
    const opp = opportunity({ deadlineDate: "2026-12-01" });
    const result = matchCandidate(cand, opp);
    expect(result.missing).toContain("Expected graduation date is before the opportunity's application deadline");
  });
});

describe("matchCandidate — experience scoring", () => {
  it("prior internship experience is credited", () => {
    const cand = candidate({ experience: [{ employmentType: "internship", isCurrent: false }] });
    const result = matchCandidate(cand, opportunity());
    expect(result.breakdown.experience).toBe(10);
    expect(result.reasons).toContain("Has relevant internship experience");
  });

  it("no experience at all is reported in missing", () => {
    const result = matchCandidate(candidate({ experience: [] }), opportunity());
    expect(result.missing).toContain("No prior experience listed");
    expect(result.breakdown.experience).toBe(0);
  });
});