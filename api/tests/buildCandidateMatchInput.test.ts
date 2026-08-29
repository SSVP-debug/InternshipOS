import { describe, it, expect } from "vitest";
import { buildCandidateMatchInput } from "../src/lib/matching/buildCandidateMatchInput.js";
import type {
  RawEducationRow,
  RawExperienceRow,
  RawProjectRow,
  RawSkillRow,
  RawWorkAuthorizationRow,
} from "../src/lib/matching/buildCandidateMatchInput.js";

describe("buildCandidateMatchInput", () => {
  it("maps full candidate data correctly across all five tables", () => {
    const skills: RawSkillRow[] = [{ name: "python" }, { name: "react" }];
    const education: RawEducationRow[] = [
      {
        degree_type: "bachelor",
        major: "Computer Science",
        enrollment_status: "current",
        expected_graduation_date: "2027-05-15",
        is_primary: true,
      },
    ];
    const experience: RawExperienceRow[] = [{ employment_type: "internship", is_current: false }];
    const projects: RawProjectRow[] = [{ tech_stack: ["typescript", "node"] }];
    const workAuthorization: RawWorkAuthorizationRow = {
      status: "f1_opt",
      requires_sponsorship: false,
      citizenship_country: "IN",
    };

    const result = buildCandidateMatchInput({ skills, education, experience, projects, workAuthorization });

    expect(result).toEqual({
      skills: [{ name: "python" }, { name: "react" }],
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
      projects: [{ techStack: ["typescript", "node"] }],
      workAuthorization: { status: "f1_opt", requiresSponsorship: false, citizenshipCountry: "IN" },
    });
  });

  it("leaves empty arrays empty rather than inventing entries", () => {
    const result = buildCandidateMatchInput({
      skills: [],
      education: [],
      experience: [],
      projects: [],
      workAuthorization: null,
    });

    expect(result.skills).toEqual([]);
    expect(result.education).toEqual([]);
    expect(result.experience).toEqual([]);
    expect(result.projects).toEqual([]);
  });

  it("maps a missing work_authorization row to null, never a defaulted object", () => {
    const result = buildCandidateMatchInput({
      skills: [],
      education: [],
      experience: [],
      projects: [],
      workAuthorization: null,
    });

    expect(result.workAuthorization).toBeNull();
  });

  it("produces no PII fields — output has exactly the five CandidateMatchInput keys", () => {
    const result = buildCandidateMatchInput({
      skills: [{ name: "python" }],
      education: [],
      experience: [],
      projects: [],
      workAuthorization: null,
    });

    expect(Object.keys(result).sort()).toEqual(
      ["skills", "education", "experience", "projects", "workAuthorization"].sort()
    );
    // No name/email/phone/location fields anywhere in the output shape.
    expect(JSON.stringify(result)).not.toMatch(/name(?!":)|email|phone|location_country|location_city/i);
  });

  it("passes enum values through unchanged (degree_type, enrollment_status, employment_type, work auth status)", () => {
    // "research" here, not "co_op" — experience.employment_type's real DB
    // constraint (0011_experience.sql) is internship/part_time/full_time/
    // research/volunteer. "co_op" is only valid for opportunity(_source)
    // .employment_type (job postings, 0017/0022), a deliberately
    // different enum for a different table — using it here would test an
    // impossible experience row.
    const result = buildCandidateMatchInput({
      skills: [],
      education: [
        {
          degree_type: "master",
          major: "Data Science",
          enrollment_status: "graduated",
          expected_graduation_date: null,
          is_primary: false,
        },
      ],
      experience: [{ employment_type: "research", is_current: true }],
      projects: [],
      workAuthorization: { status: "needs_sponsorship", requires_sponsorship: true, citizenship_country: "NG" },
    });

    expect(result.education[0].degreeType).toBe("master");
    expect(result.education[0].enrollmentStatus).toBe("graduated");
    expect(result.experience[0].employmentType).toBe("research");
    expect(result.workAuthorization?.status).toBe("needs_sponsorship");
  });

  it("maps a null expected_graduation_date straight through as null", () => {
    const result = buildCandidateMatchInput({
      skills: [],
      education: [
        {
          degree_type: "bachelor",
          major: "Physics",
          enrollment_status: "current",
          expected_graduation_date: null,
          is_primary: true,
        },
      ],
      experience: [],
      projects: [],
      workAuthorization: null,
    });

    expect(result.education[0].expectedGraduationDate).toBeNull();
  });
});
