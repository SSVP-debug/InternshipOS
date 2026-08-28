import { describe, it, expect } from "vitest";
import {
  WORK_AUTH_STATUS_OPTIONS,
  EDUCATION_DEGREE_TYPE_OPTIONS,
  EDUCATION_ENROLLMENT_STATUS_OPTIONS,
  SKILL_CATEGORY_OPTIONS,
  SKILL_SELF_RATING_OPTIONS,
  type OptionList,
} from "../src/lib/profileFieldOptions.js";

// Each expected set below is the backend's actual enum, copied from
// api/src/lib/schemas.ts (which mirrors the DB check constraints in the
// migration named in each comment) at the time these tests were written.
// If the backend enum ever changes, these tests are the intentional
// trip-wire: they will fail here rather than the failure only surfacing
// as a mysterious 400 on save in production. Order-independent
// comparisons (Set equality) since display order is a UI choice, not
// part of the contract with the backend.

function values(options: OptionList): string[] {
  return options.map(([v]) => v);
}

function hasNoDuplicateValues(options: OptionList): boolean {
  const vals = values(options);
  return new Set(vals).size === vals.length;
}

function everyOptionHasANonEmptyLabel(options: OptionList): boolean {
  return options.every(([, label]) => typeof label === "string" && label.trim().length > 0);
}

describe("WORK_AUTH_STATUS_OPTIONS — mirrors WorkAuthorizationRequestSchema.status (0008_work_authorization.sql)", () => {
  const expected = new Set([
    "us_citizen",
    "permanent_resident",
    "f1_opt",
    "f1_cpt",
    "stem_opt_eligible",
    "h1b",
    "other_visa",
    "needs_sponsorship",
    "not_applicable_non_us",
  ]);

  it("contains exactly the backend's enum values, no more, no less", () => {
    expect(new Set(values(WORK_AUTH_STATUS_OPTIONS))).toEqual(expected);
  });

  it("no longer contains the invalid legacy options that used to break saving", () => {
    // These three were the actual dropdown options before the fix, and
    // covered the three most common real answers for this app's
    // India-first/international student user base — none of them are
    // valid backend values, so every save with one of these selected
    // failed with a 400.
    const legacyInvalidValues = ["visa_holder", "requires_sponsorship", "other"];
    for (const invalid of legacyInvalidValues) {
      expect(values(WORK_AUTH_STATUS_OPTIONS)).not.toContain(invalid);
    }
  });
});

describe("EDUCATION_DEGREE_TYPE_OPTIONS — mirrors EducationRequestSchema.degree_type (0007_education.sql)", () => {
  it("contains exactly the backend's enum values", () => {
    expect(new Set(values(EDUCATION_DEGREE_TYPE_OPTIONS))).toEqual(
      new Set(["associate", "bachelor", "master", "phd", "bootcamp", "other"]),
    );
  });
});

describe("EDUCATION_ENROLLMENT_STATUS_OPTIONS — mirrors EducationRequestSchema.enrollment_status (0007_education.sql)", () => {
  const expected = new Set(["current", "graduated", "on_leave", "transferred", "withdrawn"]);

  it("contains exactly the backend's enum values", () => {
    expect(new Set(values(EDUCATION_ENROLLMENT_STATUS_OPTIONS))).toEqual(expected);
  });

  it("uses 'current', not the invalid legacy 'enrolled' value", () => {
    expect(values(EDUCATION_ENROLLMENT_STATUS_OPTIONS)).toContain("current");
    expect(values(EDUCATION_ENROLLMENT_STATUS_OPTIONS)).not.toContain("enrolled");
  });

  it("includes 'transferred', which the legacy option list omitted entirely", () => {
    expect(values(EDUCATION_ENROLLMENT_STATUS_OPTIONS)).toContain("transferred");
  });
});

describe("SKILL_CATEGORY_OPTIONS — mirrors SkillRequestSchema.category (0009_skill.sql)", () => {
  const expected = new Set(["language", "framework", "tool", "domain", "soft_skill"]);

  it("contains exactly the backend's enum values", () => {
    expect(new Set(values(SKILL_CATEGORY_OPTIONS))).toEqual(expected);
  });

  it("no longer contains the invalid legacy 'technical'/'other' values", () => {
    expect(values(SKILL_CATEGORY_OPTIONS)).not.toContain("technical");
    expect(values(SKILL_CATEGORY_OPTIONS)).not.toContain("other");
  });

  it("includes 'framework' and 'domain', which the legacy option list omitted entirely", () => {
    expect(values(SKILL_CATEGORY_OPTIONS)).toContain("framework");
    expect(values(SKILL_CATEGORY_OPTIONS)).toContain("domain");
  });
});

describe("SKILL_SELF_RATING_OPTIONS — mirrors SkillRequestSchema.self_rating (0009_skill.sql)", () => {
  it("contains exactly the backend's enum values", () => {
    expect(new Set(values(SKILL_SELF_RATING_OPTIONS))).toEqual(new Set(["exposed", "proficient", "advanced"]));
  });

  it("no longer contains the invalid legacy 'beginner'/'intermediate'/'expert' values", () => {
    for (const invalid of ["beginner", "intermediate", "expert"]) {
      expect(values(SKILL_SELF_RATING_OPTIONS)).not.toContain(invalid);
    }
  });
});

describe("all option lists — basic sanity", () => {
  const allLists: [string, OptionList][] = [
    ["WORK_AUTH_STATUS_OPTIONS", WORK_AUTH_STATUS_OPTIONS],
    ["EDUCATION_DEGREE_TYPE_OPTIONS", EDUCATION_DEGREE_TYPE_OPTIONS],
    ["EDUCATION_ENROLLMENT_STATUS_OPTIONS", EDUCATION_ENROLLMENT_STATUS_OPTIONS],
    ["SKILL_CATEGORY_OPTIONS", SKILL_CATEGORY_OPTIONS],
    ["SKILL_SELF_RATING_OPTIONS", SKILL_SELF_RATING_OPTIONS],
  ];

  for (const [name, options] of allLists) {
    it(`${name} has no duplicate values`, () => {
      expect(hasNoDuplicateValues(options)).toBe(true);
    });

    it(`${name} gives every option a non-empty label`, () => {
      expect(everyOptionHasANonEmptyLabel(options)).toBe(true);
    });
  }
});
