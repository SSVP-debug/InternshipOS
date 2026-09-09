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
    sponsorship_offered: null,
    citizenship_requirement: null,
    jurisdiction_country: null,
    eligible_candidate_countries: null,
    citizenship_required_countries: null,
    requires_existing_work_authorization: null,
    required_degree_types: null,
    required_majors: null,
    required_major_match_mode: null,
    graduation_not_before: null,
    graduation_not_after: null,
    required_enrollment_statuses: null,
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

/**
 * Minimal mock of the subset of the Supabase query builder both
 * writeOpportunitySource.ts AND (A3.2) expireStaleOpportunities.ts use.
 * `sweepRows` controls what the expiry sweep's .update().eq().lt().select()
 * chain resolves to, so tests can assert the sweep's count is wired
 * through runIngestion's returned summary correctly.
 */
function mockSupabase(
  options: {
    sweepRows?: Array<{ id: string }>;
    sweepError?: { message: string };
    upsertError?: { message: string };
  } = {}
) {
  const updateMock = vi.fn((_values: unknown) => ({
    eq: vi.fn((_col: string, _val: unknown) => ({
      lt: vi.fn((_ltCol: string, _ltVal: unknown) => ({
        select: vi.fn(async (_cols: string) => {
          if (options.sweepError) {
            return { data: null, error: options.sweepError };
          }
          return { data: options.sweepRows ?? [], error: null };
        }),
      })),
    })),
  }));

  const from = vi.fn((_table: string) => ({
    select: vi.fn((_cols: string) => ({
      in: vi.fn(async () => ({ data: [], error: null })),
    })),
    upsert: vi.fn(async () => {
      if (options.upsertError) {
        return { data: null, error: options.upsertError };
      }
      return { data: null, error: null };
    }),
    update: updateMock,
  }));
  return { from, updateMock } as any;
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

  // A3.2 — expiry sweep wiring and the ingestion-outage guard.

  it("runs the expiry sweep after a successful run and reports its count", async () => {
    const supabase = mockSupabase({ sweepRows: [{ id: "a" }, { id: "b" }] });
    const adapters = [okAdapter("adzuna", { fetched: 1, keptAfterFilter: 1, listings: [listing()] })];

    const summary = await runIngestion(supabase, adapters);

    expect(supabase.updateMock).toHaveBeenCalledTimes(1);
    expect(supabase.updateMock).toHaveBeenCalledWith({ status: "expired" });
    expect(summary.sweep).toEqual({ ran: true, expired: 2, errors: [] });
  });

  it("still runs the sweep on a PARTIAL failure (one source down, one source fine) — not a total outage", async () => {
    const supabase = mockSupabase({ sweepRows: [] });
    const adapters = [
      rejectingAdapter("adzuna", "credentials missing"),
      okAdapter("remoteok", { fetched: 2, keptAfterFilter: 2, listings: [listing({ source_name: "remoteok" })] }),
    ];

    const summary = await runIngestion(supabase, adapters);

    expect(supabase.updateMock).toHaveBeenCalledTimes(1);
    expect(summary.sweep.ran).toBe(true);
  });

  it("ingestion-outage guard: skips the sweep entirely when every source fails outright", async () => {
    const supabase = mockSupabase();
    const adapters = [rejectingAdapter("adzuna", "network down"), rejectingAdapter("remoteok", "network down")];

    const summary = await runIngestion(supabase, adapters);

    expect(supabase.updateMock).not.toHaveBeenCalled();
    expect(summary.sweep.ran).toBe(false);
    expect(summary.sweep.expired).toBe(0);
    expect(summary.sweep.skippedReason).toBeTruthy();
  });

  it("ingestion-outage guard: skips the sweep when every adapter resolves with zero fetched/inserted/updated", async () => {
    const supabase = mockSupabase();
    const adapters = [okAdapter("adzuna"), okAdapter("remoteok")];

    const summary = await runIngestion(supabase, adapters);

    expect(supabase.updateMock).not.toHaveBeenCalled();
    expect(summary.sweep.ran).toBe(false);
  });

  it("skips the sweep when called with no adapters at all", async () => {
    const supabase = mockSupabase();
    const summary = await runIngestion(supabase, []);

    expect(supabase.updateMock).not.toHaveBeenCalled();
    expect(summary.sweep.ran).toBe(false);
  });

  it("ingestion-outage guard: skips the sweep when a source fetches data but every listing is filtered out (fetched > 0, nothing written)", async () => {
    // This is the exact gap the guard fix addresses: fetched > 0 alone is
    // NOT evidence any last_seen_at advanced. Here the adapter successfully
    // reaches the network (fetched: 5) but nothing survives normalization/
    // relevance filtering (listings: [] — the "0 listings" branch in
    // runIngestion.ts, which never calls writeOpportunitySource at all), so
    // inserted and updated both stay 0.
    const supabase = mockSupabase();
    const adapters = [okAdapter("adzuna", { fetched: 5, keptAfterFilter: 0, listings: [] })];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sources[0].fetched).toBe(5);
    expect(summary.sources[0].inserted).toBe(0);
    expect(summary.sources[0].updated).toBe(0);
    expect(supabase.updateMock).not.toHaveBeenCalled();
    expect(summary.sweep.ran).toBe(false);
  });

  it("ingestion-outage guard: skips the sweep when a source fetches data but every write fails (fetched > 0, inserted/updated stay 0)", async () => {
    // The other half of the same gap: the adapter fetched real listings,
    // but the write side failed outright (bad service-role key, table
    // unreachable, etc.) — writeOpportunitySource.ts reports failed > 0
    // with inserted/updated both 0. No last_seen_at moved, so this must
    // NOT be treated as evidence the run "worked."
    const supabase = mockSupabase({ upsertError: { message: "permission denied for table opportunity_source" } });
    const adapters = [okAdapter("adzuna", { fetched: 3, keptAfterFilter: 3, listings: [listing()] })];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sources[0].fetched).toBe(3);
    expect(summary.sources[0].inserted).toBe(0);
    expect(summary.sources[0].updated).toBe(0);
    expect(summary.sources[0].failed).toBeGreaterThan(0);
    expect(supabase.updateMock).not.toHaveBeenCalled();
    expect(summary.sweep.ran).toBe(false);
  });

  it("surfaces a sweep-level database error without throwing, and still returns the rest of the summary", async () => {
    const supabase = mockSupabase({ sweepError: { message: "db unreachable" } });
    const adapters = [okAdapter("adzuna", { fetched: 1, keptAfterFilter: 1, listings: [listing()] })];

    const summary = await runIngestion(supabase, adapters);

    expect(summary.sweep).toEqual({ ran: true, expired: 0, errors: ["expiry sweep failed: db unreachable"] });
    expect(summary.sources).toHaveLength(1);
  });
});
