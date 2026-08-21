// truth-center.ts
// GET /truth-center — the read model described in
// docs/candidate-truth-layer-phase0.md §2: one screen where the student
// sees every claim that could be used in an application, its evidence, its
// trust tier, and its status, grouped by the entity it's about.
//
// This is explicitly "not a new stored entity — derived query" (§2) — no
// migration backs this route. It's a read-only aggregation over claim +
// evidence_source + the 7 candidate-fact tables, all through the caller's
// own RLS-scoped client, so — same as every other route — there is no id
// to swap out to reach another candidate's Truth Center.
//
// Design decisions made here that the doc doesn't spell out to the letter,
// flagged rather than silently assumed:
//
// 1. trust_tier for a github_repository evidence source that has NOT yet
//    been through GitHub OAuth verification (owner_verified = false):
//    treated as tier_2_document, not tier_3_self_attested — it's still a
//    real, checkable external link, just not independently confirmed yet.
//    Only owner_verified GitHub evidence reaches tier_1_verified.
//
// 2. work_authorization is the one Claim subject_entity_type that doesn't
//    fit the polymorphic pattern cleanly: 0008_work_authorization.sql made
//    it a singleton with candidate_id AS its primary key, not a separate
//    `id` column (mirroring personal_info). So for this one type,
//    subject_entity_id is looked up against work_authorization.candidate_id
//    instead of an `id` column, and its display name is the static label
//    "Work Authorization" rather than a per-row name, since there's only
//    ever one row to point to.
//
// 3. used_in_applications_count is hardcoded to 0 for every claim. Per
//    §8: "Phase 0 has no Application table yet, so this is naturally zero
//    for everyone; don't build the counter-maintenance logic now, just
//    design the Truth Center query to compute it as 0/blank until Phase 2
//    exists, then wire it up." This is that placeholder, done exactly as
//    instructed — not an oversight.
//
// 4. evidence_link for an uploaded document is the raw file_ref storage
//    path, not a signed/public URL — no file upload or Storage-URL flow
//    exists in this repo yet (same known gap noted in account.ts's
//    deletion handler), so there's nothing to sign against yet.
//
// 5. All five ClaimStatus values are included, not just CONFIRMED/DRAFT.
//    §2 explicitly wants SUPERSEDED/REVOKED visible ("this is what makes
//    SUPERSEDED/REVOKED legible: the student can see the blast radius
//    before editing something load-bearing") — hiding them here would
//    contradict that. Any status-based filtering is a client/UI concern.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";

type TrustTier = "tier_1_verified" | "tier_2_document" | "tier_3_self_attested";

const TRUST_TIER_COPY: Record<TrustTier, { label: string; explanation: string }> = {
  tier_1_verified: {
    label: "Verified",
    explanation: "Confirmed automatically from a connected source (like GitHub) — no self-reporting involved.",
  },
  tier_2_document: {
    label: "Documented",
    explanation: "Backed by an uploaded document or an external link that hasn't been independently verified yet.",
  },
  tier_3_self_attested: {
    label: "Self-reported",
    explanation: "Based only on what you entered — no supporting document or verified source.",
  },
};

const SUBJECT_ENTITY_TYPES = [
  "education",
  "work_authorization",
  "skill",
  "project",
  "experience",
  "achievement",
  "certification",
] as const;
type SubjectEntityType = (typeof SUBJECT_ENTITY_TYPES)[number];

interface EntityLookupConfig {
  table: string;
  idColumn: string;
  label: string;
  nameOf: (row: Record<string, unknown>) => string;
}

const ENTITY_LOOKUP: Record<SubjectEntityType, EntityLookupConfig> = {
  education: { table: "education", idColumn: "id", label: "Education", nameOf: (r) => String(r.institution_name) },
  work_authorization: {
    table: "work_authorization",
    idColumn: "candidate_id", // see decision #2 above — this table has no separate `id` column
    label: "Work Authorization",
    nameOf: () => "Work Authorization",
  },
  skill: { table: "skill", idColumn: "id", label: "Skill", nameOf: (r) => String(r.name) },
  project: { table: "project", idColumn: "id", label: "Project", nameOf: (r) => String(r.title) },
  experience: {
    table: "experience",
    idColumn: "id",
    label: "Experience",
    nameOf: (r) => `${String(r.title)} at ${String(r.organization)}`,
  },
  achievement: { table: "achievement", idColumn: "id", label: "Achievement", nameOf: (r) => String(r.title) },
  certification: { table: "certification", idColumn: "id", label: "Certification", nameOf: (r) => String(r.name) },
};

interface EvidenceRow {
  id: string;
  source_type: "document_upload" | "github_repository";
  title: string;
  file_ref: string | null;
  external_url: string | null;
  owner_verified: boolean;
}

function computeTrustTier(evidence: EvidenceRow | undefined): TrustTier {
  if (!evidence) return "tier_3_self_attested";
  if (evidence.source_type === "github_repository" && evidence.owner_verified) return "tier_1_verified";
  return "tier_2_document";
}

function computeEvidenceSummary(evidence: EvidenceRow | undefined, trustTier: TrustTier): string {
  if (!evidence) return "Self-reported, no supporting evidence.";
  if (trustTier === "tier_1_verified") return `Verified via GitHub: ${evidence.title}`;
  if (evidence.source_type === "github_repository") return `Linked GitHub repository (not yet verified): ${evidence.title}`;
  return `From an uploaded document: ${evidence.title}`;
}

function computeEvidenceLink(evidence: EvidenceRow | undefined): string | null {
  if (!evidence) return null;
  if (evidence.source_type === "github_repository") return evidence.external_url;
  return evidence.file_ref;
}

export function truthCenterRouter(): Router {
  const router = Router();

  router.get("/truth-center", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase.from("candidate").select("id").single();
    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const { data: claims, error: claimsError } = await supabase
      .from("claim")
      .select(
        "id, subject_entity_type, subject_entity_id, claim_text, status, evidence_source_id, last_reviewed_at, created_at"
      )
      .order("created_at", { ascending: false });

    if (claimsError) {
      return res.status(400).json({ error: "truth_center_fetch_failed", message: claimsError.message });
    }

    if (!claims || claims.length === 0) {
      return res.status(200).json({
        generated_at: new Date().toISOString(),
        claims_needing_review_count: 0,
        groups: {},
      });
    }

    // Batch-fetch every referenced evidence_source in one query.
    const evidenceIds = [...new Set(claims.map((c) => c.evidence_source_id).filter((id): id is string => !!id))];
    const evidenceById = new Map<string, EvidenceRow>();
    if (evidenceIds.length > 0) {
      const { data: evidenceRows, error: evidenceError } = await supabase
        .from("evidence_source")
        .select("id, source_type, title, file_ref, external_url, owner_verified")
        .in("id", evidenceIds);
      if (evidenceError) {
        return res.status(400).json({ error: "truth_center_fetch_failed", message: evidenceError.message });
      }
      for (const row of evidenceRows ?? []) evidenceById.set(row.id, row as EvidenceRow);
    }

    // Batch-fetch every referenced subject entity, one query per type
    // present among the claims (not per claim).
    const idsByType = new Map<SubjectEntityType, Set<string>>();
    for (const c of claims) {
      const type = c.subject_entity_type as SubjectEntityType;
      if (!ENTITY_LOOKUP[type]) continue; // unknown type — name resolution just falls back to null below
      if (!idsByType.has(type)) idsByType.set(type, new Set());
      idsByType.get(type)!.add(c.subject_entity_id);
    }

    const entityNameByKey = new Map<string, string>(); // key: `${type}:${id}`
    const lookupResults = await Promise.all(
      [...idsByType.entries()].map(async ([type, idsSet]) => {
        const config = ENTITY_LOOKUP[type];
        const ids = [...idsSet];
        const { data, error } = await supabase.from(config.table).select("*").in(config.idColumn, ids);
        return { type, config, data, error };
      })
    );

    const lookupError = lookupResults.find((r) => r.error);
    if (lookupError?.error) {
      return res.status(400).json({ error: "truth_center_fetch_failed", message: lookupError.error.message });
    }

    for (const { type, config, data } of lookupResults) {
      for (const row of data ?? []) {
        const key = `${type}:${row[config.idColumn]}`;
        entityNameByKey.set(key, config.nameOf(row));
      }
    }

    let claimsNeedingReviewCount = 0;
    const groups: Record<string, unknown[]> = {};

    for (const claim of claims) {
      if (claim.status === "DRAFT") claimsNeedingReviewCount++;

      const type = claim.subject_entity_type as SubjectEntityType;
      const config = ENTITY_LOOKUP[type];
      const entityName = entityNameByKey.get(`${type}:${claim.subject_entity_id}`) ?? null;

      const evidence = claim.evidence_source_id ? evidenceById.get(claim.evidence_source_id) : undefined;
      const trustTier = computeTrustTier(evidence);

      const entry = {
        claim_id: claim.id,
        claim_text: claim.claim_text,
        status: claim.status,
        subject_entity_type: type,
        subject_entity_id: claim.subject_entity_id,
        // null when the referenced entity no longer exists (e.g. deleted
        // after the claim was made) — the app-layer orphan-check the
        // architecture doc calls for (Day 4 note) is what's meant to catch
        // this proactively; this route degrades gracefully rather than
        // erroring the whole Truth Center over one orphaned claim.
        subject_entity_name: entityName,
        subject_entity_label: entityName ? `${config?.label ?? type}: ${entityName}` : (config?.label ?? type),
        trust_tier: trustTier,
        trust_tier_label: TRUST_TIER_COPY[trustTier].label,
        trust_tier_explanation: TRUST_TIER_COPY[trustTier].explanation,
        evidence_summary: computeEvidenceSummary(evidence, trustTier),
        evidence_link: computeEvidenceLink(evidence),
        last_reviewed_at: claim.last_reviewed_at,
        used_in_applications_count: 0, // see decision #3 above
        created_at: claim.created_at,
      };

      (groups[type] ??= []).push(entry);
    }

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      claims_needing_review_count: claimsNeedingReviewCount,
      groups,
    });
  });

  return router;
}
