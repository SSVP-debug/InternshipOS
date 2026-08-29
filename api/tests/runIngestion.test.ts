import { describe, it, expect, vi } from "vitest";
import { runIngestion } from "../src/lib/ingestion/runIngestion.js";
import type { AdapterRunResult, CanonicalListing, SourceAdapter } from "../src/lib/ingestion/types.js";

function listing(overrides: Partial<CanonicalListing> = {}): CanonicalListing {
  return {
    source_type: "job_board",
    source_name: "adzuna",
    source_ref: "abc123",
    source_url: "https://example.com/job/abc123",
    title: "Backend Engineering Intern",
    company: "Acme Corp",
    description: "A great internship.",
    location: "Bengaluru, India",
    work_mode: null,
    employment_type: "internship",
    skills: [],
    application_url: "https://example.com/job/abc123",
    deadline_date: null,
    posted_date: "2026-08-20",
    ...overrides,
  };
}

/** Minimal fake adapter — resolves with a fixed AdapterRunResult. */
function okAdapter(sourceName: string, result: Partial<AdapterRunResult> = {}): SourceAdapter {
  return {
    sourceName,
    run: vi.fn(async (): Promise<AdapterRunResult> => ({
      sourceName,
      fetched: 0,
      keptAfterFilter: 0,
      listings: [],
      errors: [],
      ...result,
    })),
  };
}

/** Fake adapter whose run() rejects outright, instead of resolving with errors populated. */
function rejectingAdapter(sourceName: string, message: string): SourceAdapter {
  return {
    sourceName,
    run: vi.fn(async () => {
      throw new Error(message);
    }),
  };
}

/** Minimal mock of the subset of the Supabase query builder writeOpportunitySource.ts uses. */
function mockSupabase() {
  const from = vi.fn((_table: string) => ({
    select: vi.fn((_cols: string) => ({
      in: vi.fn(async () => ({ data: [], error: null })),
    })),
    upsert: vi.fn(async () => ({ data: null, error: null })),
  }));
  return { from } as any;
}

describe("runIngestion", () => {
  it("runs every configured adapter and reports one summary entry per source", async () => {
    const supabase = mockSupabase();
    const adapters = [okAdapter("adzuna"), okAdapter("remoteok")];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sources).toHaveLength(2);
    expect(summary.sources.map((s) => s.sourceName)).toEqual(["adzuna", "remoteok"]);
    expect(summary.startedAt).toBeTruthy();
    expect(summary.finishedAt).toBeTruthy();
  });

  it("writes a source's listings and reports inserted/updated from the writer", async () => {
    const supabase = mockSupabase();
    const adapters = [okAdapter("adzuna", { fetched: 1, keptAfterFilter: 1, listings: [listing()] })];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sources[0].fetched).toBe(1);
    expect(summary.sources[0].keptAfterFilter).toBe(1);
    // writeOpportunitySource's own behavior is covered by writeOpportunitySource.test.ts —
    // here we only assert runIngestion wires its result through correctly.
    expect(summary.sources[0].inserted + summary.sources[0].updated).toBe(1);
  });

  it("an adapter reporting internal errors (but still resolving) does not stop the next adapter", async () => {
    const supabase = mockSupabase();
    const adapters = [
      okAdapter("adzuna", { errors: ["page 1: HTTP 500"] }),
      okAdapter("remoteok", { fetched: 3, keptAfterFilter: 3, listings: [listing({ source_name: "remoteok" })] }),
    ];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sources).toHaveLength(2);
    expect(summary.sources[0].errors).toEqual(["page 1: HTTP 500"]);
    expect(summary.sources[1].fetched).toBe(3);
  });

  it("P0 hardening: an adapter whose run() rejects outright is reported as a failed source, not thrown", async () => {
    const supabase = mockSupabase();
    const adapters = [rejectingAdapter("adzuna", "unexpected crash mid-fetch"), okAdapter("remoteok", { fetched: 5 })];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sources).toHaveLength(2);
    expect(summary.sources[0].sourceName).toBe("adzuna");
    expect(summary.sources[0].fetched).toBe(0);
    expect(summary.sources[0].errors).toEqual(["unexpected crash mid-fetch"]);
    // the second adapter still ran despite the first one rejecting
    expect(summary.sources[1].fetched).toBe(5);
  });

  it("P0 hardening: a non-Error rejection is still captured as a string, not thrown", async () => {
    const supabase = mockSupabase();
    const throwingAdapter: SourceAdapter = {
      sourceName: "weird-source",
      run: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "a plain string rejection";
      }),
    };

    const summary = await runIngestion(supabase, [throwingAdapter]);

    expect(summary.sources).toHaveLength(1);
    expect(summary.sources[0].errors).toEqual(["a plain string rejection"]);
  });

  it("returns an empty sources array when called with no adapters, without crashing", async () => {
    const supabase = mockSupabase();
    const summary = await runIngestion(supabase, []);
    expect(summary.sources).toEqual([]);
  });
});
