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
  // A3.3.2/A3.3.3: captures the exact rows passed to upsert() so tests
  // can assert on source_name/URL coercion without re-deriving them.
  const upsertedRows: unknown[] = [];

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
    upsert: vi.fn(async (rows: unknown[], _opts: unknown) => {
      upsertedRows.push(...rows);
      if (options.failOn === "upsert") {
        return { data: null, error: { message: "upsert failed" } };
      }
      return { data: null, error: null };
    }),
  }));

  return { from, upsertedRows } as any;
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

  // A3.3.2 — persist source_name ───────────────────────────────────────
  it("A3.3.2: persists source_name on the written row", async () => {
    const supabase = mockSupabase();
    await writeOpportunitySource(supabase, "remoteok", [listing({ source_name: "remoteok" })]);

    expect(supabase.upsertedRows).toHaveLength(1);
    expect(supabase.upsertedRows[0].source_name).toBe("remoteok");
  });

  it("A3.3.2: persists a different source_name for a different adapter's listing", async () => {
    const supabase = mockSupabase();
    await writeOpportunitySource(supabase, "adzuna", [listing({ source_name: "adzuna", source_ref: "adzuna-1" })]);

    expect(supabase.upsertedRows[0].source_name).toBe("adzuna");
  });

  // A3.3.3 — URL validation at ingestion ────────────────────────────────
  it("A3.3.3: keeps a well-formed https application_url/source_url unchanged", async () => {
    const supabase = mockSupabase();
    await writeOpportunitySource(
      supabase,
      "remoteok",
      [listing({ application_url: "https://example.com/apply/1", source_url: "https://example.com/job/1" })]
    );

    const row = supabase.upsertedRows[0];
    expect(row.application_url).toBe("https://example.com/apply/1");
    expect(row.source_url).toBe("https://example.com/job/1");
  });

  it("A3.3.3: coerces a malformed application_url to null without dropping the rest of the listing", async () => {
    const supabase = mockSupabase();
    const summary = await writeOpportunitySource(
      supabase,
      "remoteok",
      [listing({ application_url: "not-a-url", title: "Data Science Intern" })]
    );

    // The malformed field is nulled out, but the listing is still written
    // (not rejected wholesale) — every other field is untouched.
    expect(summary.inserted).toBe(1);
    expect(summary.failed).toBe(0);
    const row = supabase.upsertedRows[0];
    expect(row.application_url).toBeNull();
    expect(row.title).toBe("Data Science Intern");
  });

  it("A3.3.3: coerces a malformed source_url to null", async () => {
    const supabase = mockSupabase();
    await writeOpportunitySource(supabase, "remoteok", [listing({ source_url: "ftp://example.com/not-http" })]);

    expect(supabase.upsertedRows[0].source_url).toBeNull();
  });

  it("A3.3.3: coerces a null application_url/source_url to null (not an error)", async () => {
    const supabase = mockSupabase();
    await writeOpportunitySource(supabase, "remoteok", [listing({ application_url: null, source_url: null })]);

    const row = supabase.upsertedRows[0];
    expect(row.application_url).toBeNull();
    expect(row.source_url).toBeNull();
  });
});
