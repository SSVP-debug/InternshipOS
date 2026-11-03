import { describe, expect, it, vi } from "vitest";
import { defaultAdapters, runIngestion } from "../src/lib/ingestion/runIngestion.js";
import type { AdapterRunResult, SourceAdapter } from "../src/lib/ingestion/types.js";

/** Supabase stub whose every chain resolves with no rows / no error — enough for write + sweep paths. */
function emptySupabase() {
  const chain: Record<string, unknown> = {};
  const resolved = Promise.resolve({ data: [], error: null });
  for (const method of ["select", "in", "upsert", "update", "eq", "lt"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = resolved.then.bind(resolved);
  return { from: vi.fn(() => chain) } as never;
}

function adapter(sourceName: string, run: () => Promise<AdapterRunResult>): SourceAdapter {
  return { sourceName, run };
}

describe("defaultAdapters", () => {
  it("registers every source, in a stable order", () => {
    expect(defaultAdapters().map((a) => a.sourceName)).toEqual([
      "adzuna",
      "remoteok",
      "remotive",
      "greenhouse",
      "lever",
      "ashby",
    ]);
  });
});

describe("runIngestion — concurrent fetch phase", () => {
  it("starts every adapter before any of them finishes", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const make = (name: string) =>
      adapter(name, async () => {
        started.push(name);
        await gate;
        return { sourceName: name, fetched: 0, keptAfterFilter: 0, listings: [], errors: [] };
      });

    const pending = runIngestion(emptySupabase(), [make("a"), make("b"), make("c")]);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(["a", "b", "c"]); // all running at once, none finished yet
    release();
    await pending;
  });

  it("keeps summary order equal to adapter order even when a later adapter finishes first", async () => {
    const slow = adapter("slow", async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { sourceName: "slow", fetched: 1, keptAfterFilter: 0, listings: [], errors: [] };
    });
    const fast = adapter("fast", async () => ({ sourceName: "fast", fetched: 2, keptAfterFilter: 0, listings: [], errors: [] }));

    const summary = await runIngestion(emptySupabase(), [slow, fast]);
    expect(summary.sources.map((s) => s.sourceName)).toEqual(["slow", "fast"]);
  });

  it("isolates a rejecting adapter: it is reported as failed and the others still report normally", async () => {
    const bad = adapter("bad", async () => {
      throw new Error("boom");
    });
    const good = adapter("good", async () => ({ sourceName: "good", fetched: 5, keptAfterFilter: 0, listings: [], errors: [] }));

    const summary = await runIngestion(emptySupabase(), [bad, good]);
    expect(summary.sources[0]).toMatchObject({ sourceName: "bad", fetched: 0, errors: ["boom"] });
    expect(summary.sources[1]).toMatchObject({ sourceName: "good", fetched: 5, errors: [] });
  });
});
