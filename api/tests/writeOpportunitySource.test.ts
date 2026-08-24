import { describe, it, expect, vi } from "vitest";
import { writeOpportunitySource } from "../src/lib/ingestion/writeOpportunitySource.js";
import { computeDedupFingerprint } from "../src/lib/ingestion/dedupFingerprint.js";
import type { CanonicalListing } from "../src/lib/ingestion/types.js";

function listing(overrides: Partial<CanonicalListing> = {}): CanonicalListing {
  return {
    source_type: "job_board",
    source_name: "remoteok",
    source_ref: "1010101",
    source_url: "https://example.com/job/1010101",
    title: "Frontend Engineering Intern",
    company: "Nimbus Labs",
    description: "A great internship.",
    location: "Remote",
    work_mode: "remote",
    employment_type: "internship",
    skills: ["react"],
    application_url: "https://example.com/job/1010101",
    deadline_date: null,
    posted_date: "2026-08-10",
    ...overrides,
  };
}

/**
 * Minimal mock of the subset of the Supabase query builder this module
 * uses: .from(table).select(...).in(...) for the pre-upsert lookup, and
 * .from(table).upsert(rows, opts) for the write itself. Configurable
 * per test via `existingFingerprints` and `failOn`.
 */
function mockSupabase(options: { existingFingerprints?: string[]; failOn?: "select" | "upsert" } = {}) {
  const existing = new Set(options.existingFingerprints ?? []);

  const from = vi.fn((_table: string) => ({
    select: vi.fn((_cols: string) => ({
      in: vi.fn(async (_col: string, values: string[]) => {
        if (options.failOn === "select") {
          return { data: null, error: { message: "select failed" } };
        }
        const matched = values.filter((v) => existing.has(v)).map((v) => ({ dedup_fingerprint: v }));
        return { data: matched, error: null };
      }),
    })),
    upsert: vi.fn(async (_rows: unknown[], _opts: unknown) => {
      if (options.failOn === "upsert") {
        return { data: null, error: { message: "upsert failed" } };
      }
      return { data: null, error: null };
    }),
  }));

  return { from } as any;
}

describe("writeOpportunitySource", () => {
  it("reports every listing as inserted when none previously existed", async () => {
    const supabase = mockSupabase({ existingFingerprints: [] });
    const summary = await writeOpportunitySource(supabase, "remoteok", [listing()]);

    expect(summary.inserted).toBe(1);
    expect(summary.updated).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("reports a listing as updated when its dedup_fingerprint already exists", async () => {
    const existingFingerprint = computeDedupFingerprint("remoteok", "1010101");
    const supabase = mockSupabase({ existingFingerprints: [existingFingerprint] });
    const summary = await writeOpportunitySource(supabase, "remoteok", [listing()]);

    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("counts a batch as failed and records the error when the select lookup fails", async () => {
    const supabase = mockSupabase({ failOn: "select" });
    const summary = await writeOpportunitySource(supabase, "remoteok", [listing()]);

    expect(summary.failed).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(summary.errors[0]).toMatch(/pre-upsert lookup failed/);
  });

  it("counts a batch as failed and records the error when the upsert fails", async () => {
    const supabase = mockSupabase({ failOn: "upsert" });
    const summary = await writeOpportunitySource(supabase, "remoteok", [listing()]);

    expect(summary.failed).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(summary.errors[0]).toMatch(/upsert failed/);
  });

  it("returns a zeroed summary for an empty listings array without calling supabase", async () => {
    const supabase = mockSupabase();
    const summary = await writeOpportunitySource(supabase, "remoteok", []);

    expect(summary).toEqual({ sourceName: "remoteok", inserted: 0, updated: 0, failed: 0, errors: [] });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
