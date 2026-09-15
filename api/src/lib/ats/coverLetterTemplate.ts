// coverLetterTemplate.ts
//
// Generates a cover-letter DRAFT from structured data already in the
// candidate's own account — resume label, matched skills, opportunity
// title/company, candidate name. This is a plain string template, not
// an LLM call: this codebase has no LLM integration (no Anthropic/
// OpenAI key, no wiring anywhere), and adding one is a cost/infra
// decision for the project owner to make deliberately, not something to
// slip in as a side effect of a cover-letter feature. If real
// AI-generated prose is wanted later, that's a separate, explicit
// decision — see docs/gate-r8-lever-ats-submission.md's sibling doc (not
// yet written) for that path.
//
// The output is always meant to be reviewed and edited by the candidate
// before submission — see GET /applications/:id/cover-letter-draft's own
// comment on why this returns a draft, not a final `comments` value.

export interface CoverLetterInput {
  candidateName: string;
  opportunityTitle: string;
  company: string;
  resumeLabel: string | null;
  skillNames: string[];
}

/** Deliberately plain and a little repetitive/generic — a template
 * can't know *why* this candidate wants this specific role, so it
 * doesn't pretend to (no invented enthusiasm, no fabricated claims
 * about the company). It states facts already on file (skills, resume
 * focus) and leaves the personal "why this role" sentence as an
 * obviously-a-placeholder line for the candidate to either fill in or
 * delete. */
export function generateCoverLetterDraft(input: CoverLetterInput): string {
  const skillsLine =
    input.skillNames.length > 0
      ? `My background includes ${formatSkillList(input.skillNames)}, which I believe align well with this role.`
      : null;

  const resumeLine = input.resumeLabel
    ? `I'm applying with my "${input.resumeLabel}" resume, tailored for this kind of position.`
    : null;

  const paragraphs = [
    `Dear Hiring Team,`,
    `I'm writing to apply for the ${input.opportunityTitle} position at ${input.company}.`,
    [skillsLine, resumeLine].filter(Boolean).join(" "),
    `[Add a sentence here about why you specifically want this role or this company — a template can't write that part for you.]`,
    `Thank you for your time and consideration. I look forward to hearing from you.`,
    `Sincerely,\n${input.candidateName}`,
  ].filter((p) => p && p.length > 0);

  return paragraphs.join("\n\n");
}

function formatSkillList(names: string[]): string {
  const shown = names.slice(0, 5);
  if (shown.length === 1) return shown[0];
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`;
  return `${shown.slice(0, -1).join(", ")}, and ${shown[shown.length - 1]}`;
}
