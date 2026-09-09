import { describe, it, expect, vi } from "vitest";
import { expireStaleOpportunities, STALE_THRESHOLD_DAYS } from "../src/lib/ingestion/expireStaleOpportunities.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimal mock of the subset of the Supabase query builder this module
 * uses: .from(table).update(values).eq(col, val).lt(col, val).select(cols).
 * `capturedFilters` records what the module actually asked for, so tests
 * can assert on the query shape (status='active', the cutoff value), not
 * just the final result.
 */
function mockSupabase(options: { rows?: Array<{ id: string }>; error?: { message: string } } = {}) {
  const capturedFilters: { eqCol?: string; eqVal?: unknown; ltCol?: string; ltVal?: unknown; updateValues?: unknown } = {};

  const from = vi.fn((_table: string) => ({
    update: vi.fn((values: unknown) => {
      capturedFilters.updateValues = values;
      return {
        eq: vi.fn((col: string, val: unknown) => {
          capturedFilters.eqCol = col;
          capturedFilters.eqVal = val;
          return {
            lt: vi.fn((ltCol: string, ltVal: unknown) => {
              capturedFilters.ltCol = ltCol;
              capturedFilters.ltVal = ltVal;
              return {
                select: vi.fn(async (_cols: string) => {
                  if (options.error) {
                    return { data: null, error: options.error };
                  }
                  return { data: options.rows ?? [], error: null };
                }),
              };
            }),
          };
        }),
      };
    }),
  }));

  return { from, capturedFilters } as any;
}

describe("expireStaleOpportunities", () => {
  it("uses the 14-day threshold constant", () => {
    expect(STALE_THRESHOLD_DAYS).toBe(14);
  });

  it("filters on status='active' and last_seen_at older than the cutoff, and sets status='expired'", async () => {
    const supabase = mockSupabase({ rows: [] });
    const now = new Date("2026-09-09T00:00:00.000Z");

    await expireStaleOpportunities(supabase, now);

    expect(supabase.capturedFilters.updateValues).toEqual({ status: "expired" });
    expect(supabase.capturedFilters.eqCol).toBe("status");
    expect(supabase.capturedFilters.eqVal).toBe("active");
    expect(supabase.capturedFilters.ltCol).toBe("last_seen_at");
    // 14 days before 2026-09-09T00:00:00.000Z
    expect(supabase.capturedFilters.ltVal).toBe("2026-08-26T00:00:00.000Z");
  });

  it("reports the count of rows actually transitioned", async () => {
    const supabase = mockSupabase({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });

    const result = await expireStaleOpportunities(supabase, new Date("2026-09-09T00:00:00.000Z"));

    expect(result).toEqual({ expired: 3, errors: [] });
  });

  it("reports zero expired and no errors when nothing crosses the threshold", async () => {
    const supabase = mockSupabase({ rows: [] });

    const result = await expireStaleOpportunities(supabase, new Date("2026-09-09T00:00:00.000Z"));

    expect(result).toEqual({ expired: 0, errors: [] });
  });

  it("never throws on a database error — reports it in errors instead", async () => {
    const supabase = mockSupabase({ error: { message: "connection reset" } });

    const result = await expireStaleOpportunities(supabase, new Date("2026-09-09T00:00:00.000Z"));

    expect(result.expired).toBe(0);
    expect(result.errors).toEqual(["expiry sweep failed: connection reset"]);
  });

  it("computes the cutoff relative to the injected `now`, not wall-clock time", async () => {
    const supabase = mockSupabase({ rows: [] });
    const now = new Date("2020-01-15T12:00:00.000Z");

    await expireStaleOpportunities(supabase, now);

    const expectedCutoff = new Date(now.getTime() - 14 * DAY_MS).toISOString();
    expect(supabase.capturedFilters.ltVal).toBe(expectedCutoff);
    expect(expectedCutoff).toBe("2020-01-01T12:00:00.000Z");
  });
});
