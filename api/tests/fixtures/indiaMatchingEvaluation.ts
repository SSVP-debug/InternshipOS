// indiaMatchingEvaluation.ts
// Phase 1B.5 (continued) — India Matching Reality Test.
//
// Second offline evaluation fixture, focused on InternshipOS's PRIMARY
// market: India. Same rules as api/tests/fixtures/matchingEvaluation.ts —
// NO database I/O, NO network calls, NO modification of
// public.opportunity_source. A static dataset only.
//
// PRIVACY: indiaEvaluationCandidate is a CandidateMatchInput. That type
// has no field for name, email, phone, or location — nothing here reads
// public.personal_info, including personal_info.location_country. See
// the country-awareness audit this fixture was commissioned from: the
// instruction was explicit not to solve any gap by reading that column,
// and this file does not.
//
// IMPORTANT — THIS FIXTURE DELIBERATELY EXPOSES A REAL MODEL GAP, IT DOES
// NOT PAPER OVER IT:
//   CandidateMatchInput.workAuthorization.status today is drawn from a
//   US-immigration-shaped enum (us_citizen / permanent_resident / f1_opt /
//   f1_cpt / stem_opt_eligible / h1b / other_visa / needs_sponsorship /
//   not_applicable_non_us — see public.work_authorization,
//   0008_work_authorization.sql). None of these values correctly
//   describes "Indian citizen, working in India, no US immigration
//   relationship at all." The closest available value is the catch-all
//   `not_applicable_non_us`, which is what is used below — but that value
//   was designed as a residual "none of the US categories apply" bucket,
//   not as a first-class representation of an Indian candidate's actual
//   status. This is used here deliberately, not fixed, per this task's
//   instruction not to introduce new candidate fields yet. See the
//   written evaluation report (section K) for what a real fix requires.
//
// SOURCING RULES FOLLOWED (same as the first evaluation):
//   - No posting was invented. Every entry has a real, dereferenceable
//     sourceUrl and was retrieved on retrievedDate (2026-08-22).
//   - Fields the real posting didn't state are left `null`/`[]` rather
//     than guessed at.
//   - Where a listing's text is itself a secondary platform's paraphrase
//     of an employer's original posting (common on Internshala, which
//     labels some listings this way itself), that is noted explicitly in
//     sourceNotes rather than presented as verbatim employer language.

import type { CandidateMatchInput, OpportunityMatchInput } from "../../src/lib/matchEngine.js";

// Phase 1B.6 added 10 new eligibility-requirement fields to
// OpportunityMatchInput. Spread into every fixture's `input` as the
// honest "not stated" baseline, then overridden per-fixture only where a
// posting's real, retrieved text genuinely supports a structured value
// (see each fixture's sourceNotes) — most real Indian postings in this
// dataset did not state anything on these axes at all, which is itself a
// finding (see the written report).
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
// A plausible Indian B.Tech CSE student profile, built entirely from
// fields CandidateMatchInput already accepts — same skill/education/
// experience/project shape as the first (US-context) evaluation, so the
// two datasets are comparable, but with workAuthorization changed to the
// closest available representation of an Indian candidate (see header
// comment — this is the exposed gap, not a fix).
export const indiaEvaluationCandidate: CandidateMatchInput = {
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
    // See header comment: this is a forced fit, not a correct
    // representation. An Indian citizen working in India has no US
    // immigration relationship of any kind — `not_applicable_non_us` is
    // the closest existing enum value (a residual "none of the US
    // categories apply" bucket), used here to expose the gap rather than
    // hide it behind an inaccurate US-shaped label like "other_visa".
    status: "not_applicable_non_us",
    // Correct and unambiguous regardless of the status-field limitation
    // above: an Indian student working for an Indian employer, in India,
    // requires no employer-sponsored work authorization of any kind.
    requiresSponsorship: false,
    // Phase 1B.6: citizenshipCountry is now a required field and is the
    // one piece of real, non-PII, country-identifying data this fixture
    // was missing before. This is what makes India-aware structured
    // eligibility comparisons (jurisdiction match, citizenship allow-list)
    // possible for this candidate at all.
    citizenshipCountry: "IN",
  },
};

export interface IndiaOpportunityFixture {
  id: string;
  title: string;
  company: string;
  sourceUrl: string;
  retrievedDate: string;
  /** Context-only field for the report. NOT part of OpportunityMatchInput. */
  locationNote: string | null;
  sourceNotes: string;
  input: OpportunityMatchInput;
}

// ── Real, India-market opportunity fixtures ─────────────────────────────

export const indiaOpportunityFixtures: IndiaOpportunityFixture[] = [
  {
    id: "ramyoz-fullstack-intern",
    title: "Full Stack Development Internship",
    company: "Ramyoz",
    sourceUrl:
      "https://internshala.com/internship/detail/full-stack-development-internship-in-multiple-locations-at-ramyoz1779794388",
    retrievedDate: "2026-08-22",
    locationNote: "Multiple locations, India.",
    sourceNotes:
      'Skills from "using technologies such as HTML, CSS, JavaScript, PHP, React, Node.js, Next.js, or other ' +
      'frameworks." No sponsorship/citizenship language present (India-domestic internship — this concept does ' +
      "not naturally apply). No explicit deadline stated.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["HTML", "CSS", "JavaScript", "PHP", "React", "Node.js", "Next.js"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "explified-fullstack-intern-parttime",
    title: "Full Stack Development Work From Home Part Time Internship",
    company: "Explified (posted via Enginova Technologies)",
    sourceUrl:
      "https://internshala.com/internship/detail/work-from-home-part-time-full-stack-development-internship-at-enginova-technologies-private-limited1778950816",
    retrievedDate: "2026-08-22",
    locationNote: "Work from home, part-time, India.",
    sourceNotes:
      'Skills from "cutting-edge technologies such as AngularJS, Bubble.io, CSS, HTML, JavaScript, MongoDB, ' +
      'MySQL, Node.js, and React." No sponsorship/citizenship language present. No deadline stated.',
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "part_time",
      skills: ["AngularJS", "Bubble.io", "CSS", "HTML", "JavaScript", "MongoDB", "MySQL", "Node.js", "React"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "neeved-ventures-mern-intern",
    title: "Full Stack Development Internship (MERN)",
    company: "Neeved Ventures",
    sourceUrl:
      "https://internshala.com/internship/detail/full-stack-development-internship-in-multiple-locations-at-neeved-ventures-private-limited1781864962",
    retrievedDate: "2026-08-22",
    locationNote: "Multiple locations, India.",
    sourceNotes:
      'Skills from "using MongoDB, Express.js, React.js, and Node.js (MERN Stack)." No sponsorship/citizenship ' +
      "language present. No deadline stated.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["MongoDB", "Express.js", "React", "Node.js"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "venue-fullstack-intern",
    title: "Full Stack Development Internship",
    company: "Venue",
    sourceUrl: "https://internshala.com/internship/detail/full-stack-development-internship-in-multiple-locations-at-venue1776927421",
    retrievedDate: "2026-08-22",
    locationNote: "Multiple locations, India.",
    sourceNotes:
      'Skills from "proficient in React, Next.js, Generative AI Tools, Node.js, Express.js, MongoDB, Postman, ' +
      'APIs." No sponsorship/citizenship language present. No deadline stated.',
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["React", "Next.js", "Generative AI Tools", "Node.js", "Express.js", "MongoDB", "Postman", "APIs"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "sankar-group-fullstack-intern",
    title: "Full Stack Development Work From Home Internship",
    company: "Sankar Group",
    sourceUrl: "https://internshala.com/internship/detail/work-from-home-full-stack-development-internship-at-sankar-group1777233757",
    retrievedDate: "2026-08-22",
    locationNote: "Work from home, India.",
    sourceNotes:
      'Skills from "expertise in Node.js, React, and PostgreSQL." Deliberately chosen because "PostgreSQL" only ' +
      "appears in the evaluation candidate's project.tech_stack, not their declared skills — this fixture " +
      "exercises the projects-component (not-double-counted) credit path against a real posting, not just a " +
      "synthetic one. No sponsorship/citizenship language present. No deadline stated.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Node.js", "React", "PostgreSQL"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "she-can-foundation-fullstack-intern",
    title: "Full Stack Development Work From Home Part Time Internship",
    company: "She Can Foundation",
    sourceUrl:
      "https://internshala.com/internship/detail/work-from-home-part-time-full-stack-development-internship-at-she-can-foundation1776860516",
    retrievedDate: "2026-08-22",
    locationNote: "Work from home, part-time, India (nonprofit, women's education/mentorship mission).",
    sourceNotes:
      'Only concrete skill named is "a strong knowledge of HTML." Used deliberately as the near-zero-overlap ' +
      "case in this dataset — HTML does not normalize-match any of the evaluation candidate's declared skills. " +
      "No sponsorship/citizenship language present. No deadline stated.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "part_time",
      skills: ["HTML"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "nayepankh-foundation-fullstack-intern",
    title: "Full Stack Development Work From Home Part Time Internship",
    company: "NayePankh Foundation",
    sourceUrl:
      "https://internshala.com/internship/detail/work-from-home-part-time-full-stack-development-internship-at-nayepankh-foundation1779249651",
    retrievedDate: "2026-08-22",
    locationNote: "Work from home, part-time, India (nonprofit, education/technology mission).",
    sourceNotes:
      'No discrete skill list — posting only says "stay updated on the latest web development trends and ' +
      'technologies" and describes a "passion for making a positive impact," with no named language or ' +
      "framework. Left as empty skills[] rather than inventing one. No sponsorship/citizenship language or " +
      "deadline present.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "part_time",
      skills: [],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "maxgen-ml-intern-parttime",
    title: "Machine Learning Part Time Internship",
    company: "Maxgen Technologies",
    sourceUrl: "https://internshala.com/internship/detail/machine-learning-internship-in-pune-at-maxgen-technologies-private-limited1776316277",
    retrievedDate: "2026-08-22",
    locationNote: "Pune, India, part-time.",
    sourceNotes:
      'Skills from "proficient in Python, Machine Learning, Natural Language Processing (NLP), Artificial ' +
      'intelligence, and Deep Learning." Only "Python" normalize-matches the candidate\'s declared skills — a ' +
      "real partial-match case (candidate has general web/backend skills, not ML-specific ones). No " +
      "sponsorship/citizenship language or deadline present.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "part_time",
      skills: ["Python", "Machine Learning", "NLP", "Artificial Intelligence", "Deep Learning"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "tsteps-ml-intern",
    title: "Machine Learning Internship",
    company: "TSTEPS",
    sourceUrl: "https://internshala.com/internship/detail/machine-learning-internship-in-pune-at-tsteps-private-limited1775558876",
    retrievedDate: "2026-08-22",
    locationNote: "Pune, India.",
    sourceNotes:
      'Retrieved text describes "building and testing machine learning models using Python libraries" — the ' +
      'only concrete named technology is Python; other responsibilities ("collecting, cleaning, preprocessing ' +
      'datasets", "evaluating model performance") are described generically without naming specific libraries, ' +
      "so no further skills were inferred beyond what's explicitly named. No sponsorship/citizenship language " +
      "or deadline present.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Python"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
    },
  },
  {
    id: "talent-corner-ml-engineer-intern",
    title: "Machine Learning Engineer Internship",
    company: "Talent Corner HR Services",
    sourceUrl:
      "https://internshala.com/internship/detail/machine-learning-engineer-internship-in-mumbai-at-talent-corner-hr-services1772687003",
    retrievedDate: "2026-08-22",
    locationNote: "Mumbai, India.",
    sourceNotes:
      'No discrete skill list — posting describes being "curious about AI, machine learning, and building ' +
      'intelligent systems" and responsibilities like "model pre-processing, feature engineering, and model ' +
      'evaluation" without naming a specific language or framework. Left as empty skills[] rather than assuming ' +
      "Python was implied. No sponsorship/citizenship language or deadline present.",
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
    id: "brainwave-nextgen-aiml-intern",
    title: "Machine Learning Intern (Work From Home)",
    company: "Brainwave Nextgen Technologies",
    sourceUrl:
      "https://internshala.com/internship/detail/work-from-home-machine-learning-intern-internship-at-brainwave-nextgen-technologies1777106057",
    retrievedDate: "2026-08-22",
    locationNote: "Hi-Tech City, Hyderabad, India (posting notes in-person despite the \"work from home\" title — a real listing inconsistency, kept as-is).",
    sourceNotes:
      'No discrete skill list — describes "building machine learning models, predictive systems, and AI ' +
      'pipelines" and "training loops" without naming a specific language/library. Left as empty skills[]. The ' +
      'retrieved page itself states "Information above is Internshala\'s interpretation and paraphrasing of ' +
      'what we found on the shared link" — i.e. this is explicitly a secondary paraphrase of the employer\'s ' +
      "original listing, not verbatim employer text; flagged here for traceability rather than treated as a " +
      "primary source. No sponsorship/citizenship language or deadline present.",
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
    id: "twilio-swe-intern-india-2026",
    title: "Software Engineer Intern (January start, 6 months)",
    company: "Twilio",
    sourceUrl: "https://job-boards.greenhouse.io/twiliostudents/jobs/7383292",
    retrievedDate: "2026-08-22",
    locationNote:
      "Bengaluru, India office OR fully remote within India (explicitly limited to Karnataka, Tamil Nadu, " +
      "Telangana, Maharashtra & New Delhi per the posting).",
    sourceNotes:
      'Skills from "explored writing code in any of the following languages: Python/Java/Javascript/PHP/C or ' +
      'C++" (required) plus desired "Hadoop, spark, python, scala." Education requirement is explicit: ' +
      '"Working towards a Bachelors, Masters, or PhD degree in computer science, computer engineering or a ' +
      'related field." This is a US-headquartered, remote-first global company hiring directly into India — no ' +
      "sponsorship/visa language appears anywhere in the posting (India-domestic employment; the US-shaped " +
      "sponsorship concept genuinely does not apply here, unlike the first evaluation's US postings). No " +
      "deadline stated. Phase 1B.6: the degree/major requirement is now encoded structurally — " +
      'requiredDegreeTypes=[bachelor,master,phd] and requiredMajors=["Computer Science","Computer Engineering"] ' +
      'with matchMode="related_field", directly reflecting the posting\'s own explicit "or a related field" ' +
      "language — a deliberately looser standard than GoDaddy's below, and a real example of why the exact-vs-" +
      "related-field distinction matters.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Python", "Java", "JavaScript", "PHP", "C", "C++", "Hadoop", "Spark", "Scala"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
      jurisdictionCountry: "IN",
      requiredDegreeTypes: ["bachelor", "master", "phd"],
      requiredMajors: ["Computer Science", "Computer Engineering"],
      requiredMajorMatchMode: "related_field",
    },
  },
  {
    id: "godaddy-sde-intern-india-2026",
    title: "Intern - Software Development Engineer 2026",
    company: "GoDaddy",
    sourceUrl: "https://job-boards.greenhouse.io/eventsandinterns/jobs/6666326003",
    retrievedDate: "2026-08-22",
    locationNote: "Hybrid — Gurgaon, India office (\"You should live within commuting distance\").",
    sourceNotes:
      'Skills from "Build and improve web and cloud applications using technologies like Node.js, React, Java, ' +
      'Python, GoLang, PHP" plus "AWS, SQL/NoSQL databases, Linux, and WordPress." Education requirement is ' +
      'explicit and unusually precise for this dataset: "Currently pursuing a B.Tech in CS/IT or related field, ' +
      'graduating in 2026." The evaluation candidate\'s expectedGraduationDate is 2027-05-15 — a real, ' +
      "observable mismatch with this posting's stated graduation-year requirement, which OpportunityMatchInput " +
      "has no field to represent (see the written report, section K). No sponsorship/citizenship language " +
      "present (India-domestic hybrid role at a US-headquartered company). No deadline stated beyond the " +
      "January–June 2026 internship window itself. Phase 1B.6: the degree/major/graduation requirement is now " +
      'encoded structurally — requiredDegreeTypes=[bachelor], requiredMajors=["CS","IT"] with matchMode="exact" ' +
      '(the posting says "B.Tech in CS/IT or related field," but is treated as exact here rather than ' +
      "related_field, since CS/IT themselves are the literal required values, not a broader category the " +
      'candidate\'s major needs to be related to), and graduationNotAfter="2026-12-31" directly from "graduating ' +
      'in 2026." This is the fixture the graduation-eligibility signal is built to catch: the evaluation ' +
      "candidate's expectedGraduationDate (2027-05-15) is genuinely later than this bound.",
    input: {
      ...NO_ELIGIBILITY_REQUIREMENTS_STATED,
      employmentType: "internship",
      skills: ["Node.js", "React", "Java", "Python", "GoLang", "PHP", "AWS", "SQL"],
      sponsorshipOffered: null,
      citizenshipRequirement: null,
      deadlineDate: null,
      jurisdictionCountry: "IN",
      requiredDegreeTypes: ["bachelor"],
      requiredMajors: ["Computer Science", "Information Technology"],
      requiredMajorMatchMode: "exact",
      graduationNotAfter: "2026-12-31",
    },
  },
];