// llmBoundary.ts
//
// The single, narrow "claims-for-LLM" serializer described in
// docs/candidate-truth-layer-phase0.md §5 ("What's allowed to leave the
// system to an LLM").
//
// THIS IS THE ONLY CODE PATH IN THIS CODEBASE PERMITTED TO CONSTRUCT AN
// LLM-BOUND PAYLOAD FROM CANDIDATE DATA. No other file should query
// `personal_info`, `work_authorization`, `evidence_source` file content,
// or claim text with the intent of sending it to an LLM. Any future
// generation feature imports and calls `serializeConfirmedClaimsForLlm`
// from here — it does not write its own query against `claim` (or any
// other table) for that purpose.
//
// Phase 0 has no generation feature yet — per the architecture doc, this
// is "the contract for Phase 1+." Nothing calls this function in
// production today. It's built now, ahead of any generation code, on
// purpose: it's much cheaper to put the fence up before a codebase
// exists that depends on looser access than to retrofit it once
// generation features are already calling an LLM directly.
//
// What this function returns, and ONLY this (per §5's allowlist):
//   - claim.id                  — lets downstream generated content carry
//                                 a provenance link back to the claim it
//                                 came from (§6/§7 of the architecture
//                                 doc — generated content is "downstream
//                                 of Claims" and must be traceable to
//                                 them).
//   - claim.subject_entity_type — structural shape metadata (e.g.
//                                 "skill", "project"), not new PII.
//   - claim.claim_text          — the claim text itself, and ONLY when
//                                 status = 'CONFIRMED'.
//
// What this function will NEVER return, by construction:
//   - PersonalInfo (name, email, phone, location) — never queried here.
//   - WorkAuthorization raw fields — eligibility is computed
//     deterministically elsewhere in code, never reasoned about by an
//     LLM.
//   - Raw uploaded file / evidence content (EvidenceSource.file_ref or
//     any evidence_source column) — evidence backs a claim, it is never
//     itself sent anywhere. This function never touches the
//     evidence_source table at all.
//   - Any claim where status != 'CONFIRMED' — DRAFT, DISPUTED,
//     SUPERSEDED, and REVOKED claims are all excluded by the query
//     filter below, not by a downstream check that could be skipped.
//   - Auth/account data (auth_user_id, tokens, session data) — never
//     queried here.
//
// Ownership: like every other query in this codebase, this is meant to
// be called with the caller's own req.supabase (JWT-scoped client), so
// Postgres RLS — not this function — is what prevents reading another
// candidate's claims. This function adds the CONFIRMED-only filter on
// top of that; it does not replace RLS as the ownership boundary, and it
// does not accept or require a candidate_id parameter for that reason.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface LlmBoundClaim {
  id: string;
  subject_entity_type: string;
  claim_text: string;
}

export interface SerializeClaimsForLlmResult {
  claims: LlmBoundClaim[];
  error: null;
}

export interface SerializeClaimsForLlmError {
  claims: null;
  error: { message: string };
}

// Intentionally the ONLY select list this file ever uses. Do not widen
// this to also pull evidence_source_id, PersonalInfo, or any other
// column "just in case" — every column named here was explicitly
// approved by §5 of the architecture doc as safe to leave the system via
// an LLM call. Adding a column is a policy change, not a refactor, and
// should be reviewed against §5 before merging, not decided inline here.
const LLM_SAFE_CLAIM_COLUMNS = "id, subject_entity_type, claim_text";

/**
 * Returns the caller's own CONFIRMED claims, in the narrow shape defined
 * as safe to send to an LLM by docs/candidate-truth-layer-phase0.md §5.
 *
 * This is a read-only serializer. It does not call any LLM itself — it
 * only builds the payload that a future generation feature is allowed to
 * send onward. No generation code exists yet (deferred to Phase 1+), so
 * nothing calls this in production today; it exists so the boundary is
 * enforceable in code review the moment generation work starts.
 */
export async function serializeConfirmedClaimsForLlm(
  supabase: Pick<SupabaseClient, "from">
): Promise<SerializeClaimsForLlmResult | SerializeClaimsForLlmError> {
  const { data, error } = await supabase
    .from("claim")
    .select(LLM_SAFE_CLAIM_COLUMNS)
    .eq("status", "CONFIRMED")
    .order("created_at", { ascending: false });

  if (error) {
    return { claims: null, error: { message: error.message } };
  }

  return { claims: (data ?? []) as unknown as LlmBoundClaim[], error: null };
}