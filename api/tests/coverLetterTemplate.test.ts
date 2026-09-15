import { describe, it, expect } from "vitest";
import { generateCoverLetterDraft } from "../src/lib/ats/coverLetterTemplate.js";

describe("generateCoverLetterDraft", () => {
  it("includes the opportunity title, company, and candidate name", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "Ada Lovelace",
      opportunityTitle: "Software Engineering Intern",
      company: "Acme Corp",
      resumeLabel: null,
      skillNames: [],
    });
    expect(draft).toContain("Software Engineering Intern");
    expect(draft).toContain("Acme Corp");
    expect(draft).toContain("Ada Lovelace");
  });

  it("mentions the resume label when provided", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "Ada Lovelace",
      opportunityTitle: "Backend Intern",
      company: "Acme Corp",
      resumeLabel: "Software Development",
      skillNames: [],
    });
    expect(draft).toContain('"Software Development" resume');
  });

  it("omits the resume line entirely when no resume label is given", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "Ada Lovelace",
      opportunityTitle: "Backend Intern",
      company: "Acme Corp",
      resumeLabel: null,
      skillNames: [],
    });
    expect(draft).not.toContain("resume");
  });

  it("formats a single skill without a conjunction", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "A",
      opportunityTitle: "T",
      company: "C",
      resumeLabel: null,
      skillNames: ["Python"],
    });
    expect(draft).toContain("My background includes Python,");
  });

  it("formats two skills with 'and'", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "A",
      opportunityTitle: "T",
      company: "C",
      resumeLabel: null,
      skillNames: ["Python", "SQL"],
    });
    expect(draft).toContain("Python and SQL");
  });

  it("formats three or more skills with an Oxford comma and caps display at 5", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "A",
      opportunityTitle: "T",
      company: "C",
      resumeLabel: null,
      skillNames: ["Python", "SQL", "React", "Docker", "AWS", "Kubernetes"],
    });
    expect(draft).toContain("Python, SQL, React, Docker, and AWS");
    expect(draft).not.toContain("Kubernetes");
  });

  it("never fabricates enthusiasm or company-specific claims — always includes the obvious placeholder line", () => {
    const draft = generateCoverLetterDraft({
      candidateName: "Ada Lovelace",
      opportunityTitle: "Backend Intern",
      company: "Acme Corp",
      resumeLabel: null,
      skillNames: [],
    });
    expect(draft).toContain("[Add a sentence here");
  });
});
