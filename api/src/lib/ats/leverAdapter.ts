// leverAdapter.ts
//
// First (and currently only) real "submit to the employer" ATS
// integration — Lever's public Postings API. This is the ONE mainstream
// ATS with a submission endpoint that's genuinely public and usable
// without an employer-issued API key: it's the same endpoint Lever's own
// hosted "jobs.lever.co/{site}/{postingId}" apply page posts to under the
// hood, so any candidate-facing client is allowed to call it directly.
//
// This is NOT true of Greenhouse, Workday, iCIMS, or most other ATS
// platforms — they either have no public submission endpoint at all, or
// require an employer-granted API credential the candidate doesn't have.
// Extending auto-apply to those would need a fundamentally different
// approach (per-employer API partnership, or browser automation against
// their hosted form) — out of scope here. See
// docs/gate-r8-lever-ats-submission.md for the full scope decision.
//
// IMPORTANT — confidence level: this adapter is built from documented,
// publicly-known Lever Postings API behavior, but this environment's
// network egress does not allow reaching api.lever.co, so none of this
// has been exercised against Lever's live API. Before relying on it for
// a real application, submit-to-ats.test.ts's mocked-fetch tests confirm
// the *request shape* is correct against what's documented, but only a
// real dry_run:false call against a live posting confirms Lever still
// accepts it. Start with dry_run (the default — see application.ts).
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

/** Submits an application through Lever's public posting-apply endpoint
 * — the same one their own hosted apply page uses. `send_confirmation`
 * is left on the default (Lever emails the candidate a confirmation),
 * matching what a human applying manually would experience — nothing
 * about this should look, to the employer's ATS, any different from a
 * real person submitting through the hosted page. */
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
