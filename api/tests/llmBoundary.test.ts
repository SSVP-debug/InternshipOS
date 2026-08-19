import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serializeConfirmedClaimsForLlm } from "../src/lib/llmBoundary.js";

function queryResult(data: unknown, error: { message: string } | null = null) {
  return Promise.resolve({ data, error });
}

interface MockClaimRow {
  id: string;
  subject_entity_type: string;
  claim_text: string;
  status?: string; // present in the fixture but must never be selected/returned
}

/**
 * A mock that records every table name `.from()` is called with, so we
 * can assert — not just hope — that the serializer never touches
 * `personal_info`, `work_authorization`, or `evidence_source`. This is
 * the automatable half of the "code-review-enforced boundary" the
 * architecture doc (§5) says is worth automating.
 */
function makeTrackedSupabaseMock(opts: { claims?: MockClaimRow[]; error?: { message: string } | null }) {
  const { claims = [], error = null } = opts;
  const tablesQueried: string[] = [];
  let capturedSelectArg = "";
  let capturedEqCol = "";
  let capturedEqVal: unknown;

  const client = {
    from(table: string) {
      tablesQueried.push(table);
      return {
        select: (columns: string) => {
          capturedSelectArg = columns;
          return {
            eq: (col: string, val: unknown) => {
              capturedEqCol = col;
              capturedEqVal = val;
              return { order: () => queryResult(claims, error) };
            },
          };
        },
      };
    },
  } as unknown as Pick<SupabaseClient, "from">;

  return {
    client,
    tablesQueried,
    getCapturedSelectArg: () => capturedSelectArg,
    getCapturedEq: () => ({ col: capturedEqCol, val: capturedEqVal }),
  };
}

const FORBIDDEN_TABLES = ["personal_info", "work_authorization", "evidence_source", "candidate"];

describe("serializeConfirmedClaimsForLlm (the LLM boundary)", () => {
  it("only ever queries the claim table — never personal_info, work_authorization, evidence_source, or candidate", async () => {
    const { client, tablesQueried } = makeTrackedSupabaseMock({ claims: [] });

    await serializeConfirmedClaimsForLlm(client);

    expect(tablesQueried).toEqual(["claim"]);
    for (const forbidden of FORBIDDEN_TABLES) {
      expect(tablesQueried).not.toContain(forbidden);
    }
  });

  it("filters on status = CONFIRMED at the query level, not as a post-filter", async () => {
    const { client, getCapturedEq } = makeTrackedSupabaseMock({ claims: [] });

    await serializeConfirmedClaimsForLlm(client);

    expect(getCapturedEq()).toEqual({ col: "status", val: "CONFIRMED" });
  });

  it("selects only id, subject_entity_type, and claim_text — never evidence_source_id, PII, or status", async () => {
    const { client, getCapturedSelectArg } = makeTrackedSupabaseMock({ claims: [] });

    await serializeConfirmedClaimsForLlm(client);

    const selected = getCapturedSelectArg()
      .split(",")
      .map((c) => c.trim());
    expect(selected.sort()).toEqual(["claim_text", "id", "subject_entity_type"]);
    expect(selected).not.toContain("evidence_source_id");
    expect(selected).not.toContain("status");
    expect(selected).not.toContain("candidate_id");
  });

  it("returns claims in the narrow LLM-safe shape", async () => {
    const { client } = makeTrackedSupabaseMock({
      claims: [{ id: "claim-1", subject_entity_type: "skill", claim_text: "Proficient in TypeScript." }],
    });

    const result = await serializeConfirmedClaimsForLlm(client);

    expect(result.error).toBeNull();
    expect(result.claims).toEqual([
      { id: "claim-1", subject_entity_type: "skill", claim_text: "Proficient in TypeScript." },
    ]);
  });

  it("returns an empty array, not an error, when the candidate has no confirmed claims", async () => {
    const { client } = makeTrackedSupabaseMock({ claims: [] });

    const result = await serializeConfirmedClaimsForLlm(client);

    expect(result.error).toBeNull();
    expect(result.claims).toEqual([]);
  });

  it("surfaces a query error rather than silently returning an empty list", async () => {
    const { client } = makeTrackedSupabaseMock({ error: { message: "connection reset" } });

    const result = await serializeConfirmedClaimsForLlm(client);

    expect(result.claims).toBeNull();
    expect(result.error).toEqual({ message: "connection reset" });
  });

  it("is a pure serializer: it never calls fetch, an LLM SDK, or any network API itself", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client } = makeTrackedSupabaseMock({
      claims: [{ id: "claim-1", subject_entity_type: "project", claim_text: "Built InternshipOS." }],
    });

    await serializeConfirmedClaimsForLlm(client);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});