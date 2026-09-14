// ats.ts — small shared helpers for Gate R8 (external ATS submission)
// UI, used by both pages/applicationDetail.ts and pages/opportunityFeed.ts.
// Kept here rather than duplicated in each page, since the two pages
// need the exact same "is this even a Lever posting" filter and the same
// friendly error copy.

// Deliberately duplicates api/src/lib/ats/leverAdapter.ts's URL pattern
// rather than importing it — this is a browser bundle with no access to
// the API's source tree, and the duplication is small and stable (a URL
// shape, not business logic). This check is UI-only, to decide whether
// to even show an "Auto-apply" button — the backend's own
// parseLeverPostingUrl in submit-to-ats is what actually enforces this;
// if the two ever drift, the backend's check is what matters and this
// one just means the button might show up somewhere it shouldn't (caught
// immediately by the dry-run preview) or not show up somewhere it could
// (a missed convenience, not a correctness bug).
const LEVER_POSTING_URL_PATTERN =
  /^https?:\/\/jobs\.lever\.co\/([^/?#]+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

export function isLeverPostingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return LEVER_POSTING_URL_PATTERN.test(url.trim());
}

// Maps the backend's error codes (POST /applications/:id/submit-to-ats)
// to copy a candidate can actually act on. Falls back to the server's
// own message (or the raw code, worst case) for anything not listed here
// — see submitApplicationToAts's own comment in api.ts for the full set
// of codes the backend can return.
export const ATS_ERROR_MESSAGES: Record<string, string> = {
  external_ats_submission_disabled: "Auto-submit isn't enabled on this server yet.",
  unsupported_ats: "This posting isn't hosted on Lever — auto-submit currently only supports Lever-hosted postings.",
  resume_missing_file: "The resume attached to this application has no uploaded file — attach a document to it under Resumes first.",
  no_resume_selected: "This application has no resume selected — pick one under Tracking details first.",
  personal_info_incomplete: "Your legal name and email need to be filled in under Profile before auto-submitting.",
  opportunity_closed: "This posting is no longer open on Lever.",
  opportunity_missing_application_url: "This opportunity has no application link on file.",
  application_not_eligible_for_submission: "This application has already moved past SAVED/APPLYING — auto-submit only applies before that.",
  ats_posting_unavailable: "Couldn't reach Lever to confirm this posting is still live.",
  resume_file_unavailable: "Couldn't retrieve the resume file to attach.",
  resume_file_download_failed: "Couldn't download the resume file to attach.",
  ats_submission_failed: "Lever rejected the submission",
};

export function atsErrorMessage(error: string, fallback?: string): string {
  return ATS_ERROR_MESSAGES[error] ?? fallback ?? error;
}
