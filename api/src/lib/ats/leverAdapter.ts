// leverAdapter.ts
//
// ⚠️ CORRECTED 2026-09-19 — see docs/gate-r8-lever-ats-submission.md's
// correction notice at the top for the full story. Short version: the
// submitLeverApplication() function below sends a POST with no `key`
// parameter, on the incorrect assumption that Lever's apply endpoint was
// public like its read-only GET postings endpoint is. It is NOT. Lever's
// own docs (github.com/lever/postings-api) state the POST endpoint
// requires `?key=APIKEY`, an API key only the EMPLOYER's Lever Super
// Admin can generate — not something a candidate-side tool can obtain
// for an arbitrary company. Every real (non-dry-run) call this function
// makes against an actual posting will fail authentication. This was
// verified directly against Lever's own documentation, not assumed —
// unlike the original version of this comment, which asserted the
// opposite without checking.
//
// getLeverPosting() below is unaffected: the GET /v0/postings/... read
// endpoint genuinely is public and keyless, confirmed both by Lever's
// own docs and independently by multiple job-board-scraper tools that
// rely on exactly that. Only the submission half of this file is wrong.
//
// Broader finding from the same verification pass: Greenhouse, Workable,
// SmartRecruiters, Breezy HR, Ashby, and Recruitee were also checked.
// All six require an employer-issued API key or OAuth token to submit an
// application programmatically — same category as Lever's real
// behavior. No mainstream ATS checked has a public, candidate-callable
// submission endpoint. This file's original framing — "Lever is the one
// exception" — does not hold.
//
// Deliberately narrow scope, matching this codebase's "don't guess"
// posture elsewhere (adzunaAdapter.ts's conservative skill extraction,
// opportunity's tri-state eligibility columns): this adapter only fills
// Lever's stable base application fields (name, email, phone, resume
// file, a free-text comments field). It does NOT attempt to detect or
// answer posting-specific custom screening questions — there is no
// reliable way to discover a posting's custom question schema from the
// public read API, and guessing wrong (or leaving a required field
// silently blank) is worse than refusing. If a posting requires custom
// answers beyond the base fields, Lever's own submission endpoint is
// expected to reject the request server-side for missing required
// fields; that rejection is surfaced as a normal submission failure by
// the caller (api/src/routes/application.ts), never swallowed or
// retried with guessed data.

const LEVER_POSTING_URL_PATTERN =
  /^https?:\/\/jobs\.lever\.co\/([^/?#]+)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

export interface LeverPostingRef {
  site: string;
  postingId: string;
}

/** Returns null (not a rejection reason, just "not a Lever URL") if the
 * URL doesn't match Lever's hosted posting URL shape. Callers should
 * treat null as "this opportunity isn't submittable via this adapter",
 * not as an error. */
export function parseLeverPostingUrl(url: string): LeverPostingRef | null {
  const match = LEVER_POSTING_URL_PATTERN.exec(url.trim());
  if (!match) return null;
  return { site: match[1], postingId: match[2] };
}

export interface LeverPosting {
  id: string;
  text: string; // job title
  state: string; // "published" for a live, currently-accepting posting
  hostedUrl: string;
}

export type LeverPostingResult = { ok: true; posting: LeverPosting } | { ok: false; status: number; message: string };

/** Confirms a posting still exists and is currently open before
 * attempting a submission — Lever returns 404 for a removed/expired
 * posting, which this surfaces as a clear "opportunity_closed"-style
 * result rather than a confusing failure deeper in the submit call. */
export async function getLeverPosting(ref: LeverPostingRef): Promise<LeverPostingResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(ref.site)}/${encodeURIComponent(ref.postingId)}?mode=json`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : "network_error" };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, message: `Lever returned ${response.status} for this posting` };
  }

  const data = (await response.json()) as Partial<LeverPosting>;
  if (!data.id || !data.state) {
    return { ok: false, status: 502, message: "Lever posting response missing expected fields" };
  }

  return { ok: true, posting: data as LeverPosting };
}

export interface LeverApplicationInput {
  name: string;
  email: string;
  phone?: string;
  comments?: string;
  resumeFile: {
    bytes: ArrayBuffer;
    filename: string;
    contentType: string;
  };
}

export type LeverSubmitResult =
  | { ok: true; status: number }
  | { ok: false; status: number; message: string };

/** ⚠️ BROKEN as written — see this file's header comment (2026-09-19
 * correction). This POSTs to Lever's apply endpoint with no `key`
 * parameter. Lever's own docs require `?key=APIKEY`, an employer-issued
 * credential this function has no way to supply. Every call against a
 * real posting will be rejected by Lever's authentication, not silently
 * accepted. Left in place (rather than deleted) because the request
 * *shape* below — field names, multipart resume handling — is still
 * accurate to Lever's documented POST API and would be the right
 * starting point if this were ever revisited with an actual API key
 * obtained some other way (which is not a realistic path for a
 * candidate-side tool against an arbitrary employer's account). */
export async function submitLeverApplication(
  ref: LeverPostingRef,
  input: LeverApplicationInput,
): Promise<LeverSubmitResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(ref.site)}/${encodeURIComponent(ref.postingId)}`;

  const form = new FormData();
  form.set("name", input.name);
  form.set("email", input.email);
  if (input.phone) form.set("phone", input.phone);
  if (input.comments) form.set("comments", input.comments);
  form.set("resume", new Blob([input.resumeFile.bytes], { type: input.resumeFile.contentType }), input.resumeFile.filename);

  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form });
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : "network_error" };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      message: bodyText || `Lever rejected the submission with status ${response.status}`,
    };
  }

  return { ok: true, status: response.status };
}
