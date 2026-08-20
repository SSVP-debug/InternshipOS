// check-orphan-claims.ts
// Run with: npm run check:orphan-claims
//
// WHAT THIS DOES: claim.subject_entity_id has no database-level foreign
// key (Postgres can't FK one column across multiple target tables) — see
// the design note at the top of supabase/migrations/0016_claim.sql:
// "the application-layer integrity check (validate on write, plus a
// script for the orphan-check, run manually for now rather than as a
// cron job)". This is that script. It has never existed in this repo
// until now; every claim ever written by the API is already validated at
// write time by ClaimRequestSchema (subject_entity_id must be a valid
// UUID) and by RLS (a claim's candidate_id must be the caller's own), but
// nothing previously checked that subject_entity_id actually points at
// an existing row OWNED BY THE SAME CANDIDATE in the table named by
// subject_entity_type. This script is that missing check, run manually
// (or wired into a scheduled job later) rather than enforced live.
//
// WHAT COUNTS AS "ORPHAN" HERE:
//   1. subject_entity_id does not exist at all in the target table, or
//   2. subject_entity_id exists but belongs to a DIFFERENT candidate_id
//      than the claim's own candidate_id — this second case is more
//      serious than a simple dangling reference: it would mean a claim
//      is pointing at another candidate's education/skill/project/etc.
//      row, which should be structurally impossible today (nothing in
//      the API lets a candidate submit someone else's entity id and have
//      it accepted, since every write path resolves candidate_id from
//      the caller's own JWT — see routes/claim.ts's getOwnCandidateId).
//      Reported as a distinct category so it's not confused with simple
//      historical drift (e.g. a since-superseded/deleted entity).
//
// SECURITY: uses the service_role key (the ONLY legitimate reason for a
// script outside the API to do so — this is a read-only, offline,
// operator-run integrity check across every candidate's data, which is
// exactly the kind of cross-candidate access RLS is supposed to block
// for the API itself). Never wire this into any request-serving code
// path. Read-only: performs no writes, no deletes, no updates.
//
// USAGE:
//   cd api
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run check:orphan-claims
// Exits 0 with no orphans found, exits 1 (and prints a report) if any
// orphans are found, so it's usable as a CI/cron gate later without
// changes to this script.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.\n" +
      "This script deliberately requires the service_role key (not the anon key) — it is a\n" +
      "read-only, cross-candidate, operator-run integrity check, not a per-user request path."
  );
  process.exit(1);
}

// Maps claim.subject_entity_type -> the table it names, per the check
// constraint in 0016_claim.sql. Kept as an explicit, exhaustive map
// (rather than deriving the table name from the string) so a future
// subject_entity_type value added to the claim table's check constraint
// without a matching entry here fails loudly (via the "unhandled type"
// branch below) instead of silently skipping validation for it.
const ENTITY_TABLES: Record<string, string> = {
  education: "education",
  work_authorization: "work_authorization",
  skill: "skill",
  project: "project",
  experience: "experience",
  achievement: "achievement",
  certification: "certification",
};

interface ClaimRow {
  id: string;
  candidate_id: string;
  subject_entity_type: string;
  subject_entity_id: string;
}

interface OrphanReport {
  claimId: string;
  candidateId: string;
  subjectEntityType: string;
  subjectEntityId: string;
  reason: "missing_entity_row" | "entity_owned_by_different_candidate" | "unhandled_subject_entity_type";
}

async function main(): Promise<void> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claims, error: claimsError } = await supabase
    .from("claim")
    .select("id, candidate_id, subject_entity_type, subject_entity_id")
    .returns<ClaimRow[]>();

  if (claimsError) {
    console.error("Failed to fetch claims:", claimsError.message);
    process.exit(1);
  }

  const orphans: OrphanReport[] = [];
  const byType = new Map<string, ClaimRow[]>();
  for (const claim of claims ?? []) {
    const bucket = byType.get(claim.subject_entity_type) ?? [];
    bucket.push(claim);
    byType.set(claim.subject_entity_type, bucket);
  }

  for (const [subjectEntityType, claimsOfType] of byType) {
    const tableName = ENTITY_TABLES[subjectEntityType];
    if (!tableName) {
      for (const claim of claimsOfType) {
        orphans.push({
          claimId: claim.id,
          candidateId: claim.candidate_id,
          subjectEntityType: claim.subject_entity_type,
          subjectEntityId: claim.subject_entity_id,
          reason: "unhandled_subject_entity_type",
        });
      }
      continue;
    }

    const entityIds = [...new Set(claimsOfType.map((c) => c.subject_entity_id))];
    const { data: entityRows, error: entityError } = await supabase
      .from(tableName)
      .select("id, candidate_id")
      .in("id", entityIds)
      .returns<{ id: string; candidate_id: string }[]>();

    if (entityError) {
      console.error(`Failed to fetch ${tableName} rows:`, entityError.message);
      process.exit(1);
    }

    const ownerByEntityId = new Map((entityRows ?? []).map((row) => [row.id, row.candidate_id]));

    for (const claim of claimsOfType) {
      const owner = ownerByEntityId.get(claim.subject_entity_id);
      if (owner === undefined) {
        orphans.push({
          claimId: claim.id,
          candidateId: claim.candidate_id,
          subjectEntityType: claim.subject_entity_type,
          subjectEntityId: claim.subject_entity_id,
          reason: "missing_entity_row",
        });
      } else if (owner !== claim.candidate_id) {
        orphans.push({
          claimId: claim.id,
          candidateId: claim.candidate_id,
          subjectEntityType: claim.subject_entity_type,
          subjectEntityId: claim.subject_entity_id,
          reason: "entity_owned_by_different_candidate",
        });
      }
    }
  }

  console.log(`Checked ${claims?.length ?? 0} claim row(s) across ${byType.size} subject_entity_type value(s).`);

  if (orphans.length === 0) {
    console.log("No orphaned claims found.");
    process.exit(0);
  }

  console.error(`Found ${orphans.length} orphaned claim(s):`);
  for (const o of orphans) {
    console.error(`  - claim=${o.claimId} candidate=${o.candidateId} type=${o.subjectEntityType} ` +
      `subject_entity_id=${o.subjectEntityId} reason=${o.reason}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("check-orphan-claims failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
