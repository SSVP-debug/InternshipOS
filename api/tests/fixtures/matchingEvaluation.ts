 // matchingEvaluation.ts
// Phase 1B.5 — Matching Reality Test. Offline evaluation fixture only.
//
// This file contains NO database I/O, NO network calls, and NO
// modification of public.opportunity_source. It is a static, hand-built
// dataset: one evaluation candidate (built exclusively from the
// non-PII fields matchEngine.ts already accepts) and 14 REAL internship
// / entry-level job postings retrieved from public sources on
// 2026-08-22, normalized into the existing OpportunityMatchInput shape.
//
// PRIVACY: evaluationCandidate is a CandidateMatchInput. That type has no
// field for name, email, phone, or location — there is nothing here to
// accidentally leak. No public.personal_info data was read or used.
//
// SOURCING RULES FOLLOWED:
//   - No posting was invented. Every entry below has a real, dereferenceable
//     sourceUrl and was retrieved on retrievedDate (2026-08-22).
//   - Where a real posting did not state a field (e.g. no explicit
//     sponsorship policy, no explicit deadline), that field is left `null`
//     or `[]` rather than guessed at, exactly as OpportunityMatchInput
//     already models "not stated."
//   - Quoted fragments in `sourceNotes` are kept short and used only to
//     document *why* a field was set the way it was (traceability), not
//     reproduced as marketing copy.
//   - `workModeNote` and other non-matcher fields exist for the human-
//     readable report only — matchEngine.ts's OpportunityMatchInput does
//     not accept work mode or location (see the Phase 1B audit, which
//     deliberately excluded them), so these fields are NOT passed into
//     matchCandidate() at all.

import type { CandidateMatchInput, OpportunityMatchInput } from "../../src/lib/matchEngine.js";

// Phase 1B.6 added 10 new eligibility-requirement fields to
// OpportunityMatchInput. None of the postings retrieved for THIS (US/
// international) evaluation stated any of them in a form this module can
// structure — see each fixture's sourceNotes for what free text was
// actually available. Spread this into every fixture's `input` as the
// honest baseline ("not stated"), then override individual fields only
// where a posting's real text genuinely supports a structured value.
const NO_ELIGIBILITY_REQUIREMENTS_STATED: Pick<
  OpportunityMatchInput,
  | "jurisdictionCountry"
  | "eligibleCandidateCountries"
  | "citizenshipRequiredCountries"
  | "requiresExistingWorkAuthorization"
  | "requiredDegreeTypes"
  | "requiredMajors"
  | "requiredMajorMatchMode"
  | "graduationNotBefore"
  | "graduationNotAfter"
  | "requiredEnrollmentStatuses"
> = {
  jurisdictionCountry: null,
  eligibleCandidateCountries: null,
  citizenshipRequiredCountries: null,
  requiresExistingWorkAuthorization: null,
  requiredDegreeTypes: null,
  requiredMajors: null,
  requiredMajorMatchMode: null,
  graduationNotBefore: null,
  graduationNotAfter: null,
  requiredEnrollmentStatuses: null,
};

// ── The evaluation candidate ────────────────────────────────────────────
// A plausible CS-student profile built entirely from fields
// CandidateMatchInput already accepts. Deliberately overlaps "React",
// "Node.js", and "TypeScript" between `skills` and `projects.techStack`
// (to exercise the no-double-counting rule against real postings), and
// includes "PostgreSQL" only in a project (project-only evidence).
// workAuthorization models an F-1 student on OPT who requires employer
// sponsorship — chosen specifically because it's the case that actually
// exercises the eligibility logic against real postings below (several
// of which explicitly do or don't offer sponsorship).
export const evaluationCandidate: CandidateMatchInput = {
  skills: [
    { name: "React" },
    { name: "Node.js" },
    { name: "Python" },
    { name: "SQL" },
    { name: "Git" },
    { name: "TypeScript" },
  ],
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
  projects: [{ techStack: ["React", "Node.js", "PostgreSQL", "TypeScript"] }],
  workAuthorization: {
    status: "f1_opt",
    requiresSponsorship: true,
    // Phase 1B.6: citizenshipCountry is now a required field on
    // WorkAuthorizationSignal. This fixture predates that change and used
    // an F-1 OPT candidate without specifying citizenship at all — "BR"
    // (Brazil) is used here purely as an illustrative, arbitrary choice
    // consistent with "international student on F-1 status," not a
    // statement about any real population. It has no bearing on this
    // dataset's US-postings results, since none of them use structured
    // citizenship-country comparison (see NO_ELIGIBILITY_REQUIREMENTS_STATED
    // above) except the US Dept of State fixture, which is evaluated via
    // citizenshipRequiredCountries=["US"] regardless of which non-US
    // country is used here.
    citizenshipCountry: "BR",
  },
};

export interface OpportunityFixture {
  /** Short stable identifier for referencing this fixture in test output. */
  id: string;
  title: string;
  company: string;
  /** Real, dereferenceable URL the posting was retrieved from. */
  sourceUrl: string;
  /** ISO date this posting's content was retrieved and normalized. */
  retrievedDate: string;
  /**
   * Context-only field for the human-readable report. NOT part of
   * OpportunityMatchInput and NOT passed into matchCandidate() — the
   * matcher's input contract deliberately has no work-mode/location
   * field (Phase 1B audit).
   */
  workModeNote: string | null;
  /** Short note on how a field was derived from the real posting text, for traceability. */
  sourceNotes: string;
  input: OpportunityMatchInput;
}

// ── Real opportunity fixtures ───────────────────────────────────────────

export const opportunityFixtures: OpportunityFixture[] = [
  {
    id: "affirm-swe-intern-2026",
    title: "Software Engineering Intern - Summer 2026",
    company: "Affirm",
    sourceUrl: "https://job-boards.greenhouse.io/affirm/jobs/7528020003",
    retrievedDate: "2026-08-22",
    workModeNote: "Remote-first company; role based in San Francisco, CA.",
    sourceNotes:
      'Skills from "Experience with Python, C/C++ or Java", "Frontend experience in WebApps/JavaScript/AngularJS/React", ' +
      'and "AWS or other PaaS frameworks". sponsorshipOffered=false is a direct, unambiguous statement: ' +
      '"Please note that visa sponsorship is not available for this position." No deadline was stated on the page.',
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Python", "C++", "Java", "JavaScript", "AngularJS", "React", "AWS"],
      sponsorshipOffered: false,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "singlestore-swe-intern-helios-2026",
    title: "Software Engineer Intern, Helios (Summer 2026)",
    company: "SingleStore",
    sourceUrl: "https://job-boards.greenhouse.io/singlestore/jobs/7782709",
    retrievedDate: "2026-08-22",
    workModeNote: null,
    sourceNotes:
      'Skills from "Strong programming skills with JavaScript, Golang or TypeScript". ' +
      'sponsorshipOffered=true is a direct statement: "Sponsorship is available for this position and other select roles." ' +
      "No deadline was stated on the page.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["JavaScript", "Golang", "TypeScript"],
      sponsorshipOffered: true,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "scowtt-fullstack-swe-intern",
    title: "Intern - Full Stack Software Engineering",
    company: "Scowtt Inc",
    sourceUrl: "https://job-boards.greenhouse.io/scowtt/jobs/4184582009",
    retrievedDate: "2026-08-22",
    workModeNote: null,
    sourceNotes:
      'Skills from "developing software using technologies like Node.js, React/Next.js, TypeScript". ' +
      'sponsorshipOffered left null (not true/false) because the actual statement is genuinely non-committal: ' +
      '"We are open to consider future visa sponsorship requirements" — this is not a clear yes or no, ' +
      "so it is deliberately NOT coerced to either boolean. No deadline was stated on the page.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Node.js", "React", "Next.js", "TypeScript"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "offerup-swe-intern-2026",
    title: "Software Engineering Intern - Summer 2026 (Hybrid @ Bellevue, WA)",
    company: "OfferUp",
    sourceUrl: "https://job-boards.greenhouse.io/offerup/jobs/8004171",
    retrievedDate: "2026-08-22",
    workModeNote: "Hybrid, 3 days/week in Bellevue, WA office.",
    sourceNotes:
      "No discrete skills list on this posting — only prose mentioning \"Familiarity with Java or a similar " +
      'programming language" as "Helpful, but not required." Left as an empty skills[] rather than guessing at a ' +
      "list, per the no-invention rule. No sponsorship statement and no deadline were present on the page.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: [],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "spacex-swe-internship-coop-2026",
    title: "Summer 2026 Software Engineering Internship/Co-op",
    company: "SpaceX",
    sourceUrl: "https://job-boards.greenhouse.io/spacex/jobs/8149154002",
    retrievedDate: "2026-08-22",
    workModeNote: "On-site (Hawthorne, CA per posting group).",
    sourceNotes:
      'Skills from "ASIC design, computer architecture, Verilog/SystemVerilog, C/C++, EE/RF circuit design" — ' +
      '"Verilog/SystemVerilog" and "C/C++" split into discrete tokens. Posting explicitly offers both an ' +
      '"internship" and "co-op" track; employmentType set to co_op here to exercise that category. ' +
      "No sponsorship statement and no deadline were present in the retrieved text.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "co_op",
      skills: ["Verilog", "SystemVerilog", "C", "C++"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "northmarq-it-swe-intern-2026",
    title: "Software Engineering Intern, Summer 2026",
    company: "Northmarq",
    sourceUrl: "https://job-boards.greenhouse.io/northmarq/jobs/4902344008",
    retrievedDate: "2026-08-22",
    workModeNote: "In-office, Minneapolis (Bloomington, MN) headquarters.",
    sourceNotes:
      'Skills from "Experience in object-oriented programming (C#, Java, C++, or similar)". ' +
      "No sponsorship statement and no deadline were present in the retrieved text.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["C#", "Java", "C++"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "freeform-swe-intern-2026",
    title: "Software Engineering Intern (Summer 2026)",
    company: "Freeform",
    sourceUrl: "https://job-boards.greenhouse.io/freeformfuturecorp/jobs/6828427003",
    retrievedDate: "2026-08-22",
    workModeNote: "On-site (autonomous metal 3D printing factory).",
    sourceNotes:
      'Skills from "programming with C/C++" (posting emphasizes engineering-club/robotics experience over ' +
      "a broad tech stack). No sponsorship statement and no deadline were present in the retrieved text.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["C", "C++"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "us-dept-of-state-student-internship-2027",
    title: "U.S. Department of State Paid Student Internship Program – Spring 2027 and Summer 2027",
    company: "U.S. Department of State",
    sourceUrl: "https://www.usajobs.gov/job/879740200",
    retrievedDate: "2026-08-22",
    workModeNote: "On-site — Department of State posts, overseas and domestic (not remote/telework eligible per posting).",
    sourceNotes:
      "No technical skills listed at all (federal student-trainee role; qualifications are citizenship, GPA, " +
      "enrollment status). citizenshipRequirement retains the verbatim condition-of-employment text: " +
      '"Be a United States citizen at the time of application." Phase 1B.6 update: this posting is unambiguous ' +
      "enough to also encode structurally — citizenshipRequiredCountries=[\"US\"] and jurisdictionCountry=\"US\" — " +
      "which is exactly the kind of real requirement the old literal-phrase parser handled unreliably (see the " +
      "Phase 1B.5 US evaluation report's false-negative finding on this exact posting) and the new structured " +
      "comparison handles directly. No explicit sponsorship-policy statement is present (sponsorship isn't the " +
      "applicable concept for a federal position) so sponsorshipOffered is left null. The posting gives " +
      "application-period date ranges (e.g. Aug 7–Sept 1) rather than a single closing date, so deadlineDate is " +
      "left null rather than picking one date out of a range.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: [],
      sponsorshipOffered: null,
      citizenshipRequirement: "Be a United States citizen at the time of application.",
      deadlineDate: null,
      jurisdictionCountry: "US",
      citizenshipRequiredCountries: ["US"],
    },
  },
  {
    id: "cloudflare-content-marketing-intern-2026",
    title: "Content Marketing Intern (Summer 2026)",
    company: "Cloudflare",
    sourceUrl: "https://job-boards.greenhouse.io/cloudflare/jobs/7733145",
    retrievedDate: "2026-08-22",
    workModeNote: "In-office, Austin, TX, 3-5 days/week.",
    sourceNotes:
      "No technical skills — role requires a portfolio, SEO/AEO understanding, and writing ability, none of which " +
      "map onto the candidate skill vocabulary this matcher compares against. Left skills as empty rather than " +
      'forcing "SEO"/"writing" into a technical-skill list they don\'t belong in. Posting states an explicit ' +
      'preferred field of study — "Journalism, English, Marketing, Communications, or related field" — encoded ' +
      "structurally via requiredMajors (Phase 1B.6); matchMode set to exact since the candidate's Computer Science " +
      "major is unambiguously outside this list (not a borderline related-field judgment call). No sponsorship " +
      "statement or deadline were present in the retrieved text.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: [],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
      jurisdictionCountry: "US",
      requiredMajors: ["Journalism", "English", "Marketing", "Communications"],
      requiredMajorMatchMode: "exact",
    },
  },
  {
    id: "cloudflare-data-science-intern-2026",
    title: "Data Science Intern (Summer 2026)",
    company: "Cloudflare",
    sourceUrl: "https://job-boards.greenhouse.io/cloudflare/jobs/7444764",
    retrievedDate: "2026-08-22",
    workModeNote: "Austin, TX team.",
    sourceNotes:
      'Skills from "Experience working with programming languages such as Python, SQL or Javascript". ' +
      "citizenshipRequirement is the verbatim export-control clause from the posting: \"This position may require " +
      "access to information protected under U.S. export control laws, including the U.S. Export Administration " +
      'Regulations." This text does NOT state a citizenship requirement in the narrow sense the matcher looks for — ' +
      "it is exactly the kind of ambiguous legal language the matcher is deliberately built not to parse " +
      "aggressively. sponsorshipOffered left null; no separate sponsorship policy was stated. No deadline was present.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Python", "SQL", "JavaScript"],
      sponsorshipOffered: null,
      citizenshipRequirement:
        "This position may require access to information protected under U.S. export control laws, including the U.S. Export Administration Regulations.",
      deadlineDate: null,
      jurisdictionCountry: "US",
    },
  },
  {
    id: "double-good-data-analyst-intern-2026",
    title: "Data Analyst Intern (Summer 2026)",
    company: "Double Good",
    sourceUrl: "https://job-boards.greenhouse.io/doublegood/jobs/5832697004",
    retrievedDate: "2026-08-22",
    workModeNote: null,
    sourceNotes:
      'Skills from "Familiarity with SQL or comparable query languages" and "Experience in Microsoft Excel or ' +
      'Google Sheets." No sponsorship statement or deadline were present in the retrieved text. (Posting also ' +
      'states an expected graduation date of Spring 2027 for the ROLE\'s target candidate pool — that is a ' +
      "candidate-side detail, not an opportunity-side field this matcher's OpportunityMatchInput models, so it " +
      "isn't represented here.)",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["SQL", "Excel"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "sonar-purchase-to-pay-intern",
    title: "Purchase to Pay Intern (Paid Internship)",
    company: "Sonar",
    sourceUrl: "https://jobs.lever.co/sonarsource/d1c1c192-157e-4b96-9aef-a63860511ec5",
    retrievedDate: "2026-08-22",
    workModeNote: "On-site, Austin, TX (3 days in-office / 2 remote per company-wide policy).",
    sourceNotes:
      'Skills from "Proficient in standard computer applications, especially the Microsoft Office Suite" — a ' +
      "finance/ops role, not a technical one. sponsorshipOffered=false is a direct statement: " +
      '"We do not currently support visa candidates in the US." Role is structured as a part-time (15-20 hrs/week) ' +
      "role during the academic year (full-time only over summer), so employmentType is set to part_time here. " +
      "No deadline was present in the retrieved text.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "part_time",
      skills: ["Microsoft Office"],
      sponsorshipOffered: false,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "uber-freight-data-scientist-intern-fall-2026",
    title: "Data Scientist Intern - Fall 2026",
    company: "Uber Freight",
    sourceUrl: "https://job-boards.greenhouse.io/uberfreight/jobs/5194491008",
    retrievedDate: "2026-08-22",
    workModeNote: "Chicago, IL.",
    sourceNotes:
      'Skills from "programming languages like Python or R" and "Proficiency in SQL for data manipulation and ' +
      'analysis." No sponsorship statement or deadline were present in the retrieved text.',
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Python", "R", "SQL"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "perpay-swe-new-grad",
    title: "Software Engineer, New Grad",
    company: "Perpay",
    sourceUrl: "https://job-boards.greenhouse.io/perpay/jobs/4034578007",
    retrievedDate: "2026-08-22",
    workModeNote: "100% on-site, Philadelphia, PA (explicitly not remote per posting).",
    sourceNotes:
      'Skills from "Our tech stack: Javascript, React, React Native, Redux, Python, Django, Kubernetes, AWS, ' +
      'Docker, Terraform, and more" and "Experience with frontend technologies such as React, Angular, or Vue.js." ' +
      "This is a full-time new-grad role (not an internship), used here for employmentType=full_time coverage. " +
      "The application form asks a standard sponsorship-status question but the posting body states no company " +
      "sponsorship policy, so sponsorshipOffered is left null rather than inferred from the question's presence. " +
      "No deadline was present in the retrieved text.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "full_time",
      skills: ["JavaScript", "React", "React Native", "Python", "Django", "AWS"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
];