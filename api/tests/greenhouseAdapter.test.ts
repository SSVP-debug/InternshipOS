import { describe, it, expect, vi } from "vitest";
import { createGreenhouseAdapter, parseGreenhouseListings } from "../src/lib/ingestion/adapters/greenhouseAdapter.js";
import { greenhouseSampleResponse } from "./fixtures/atsBoardSamples.js";

const board = { slug: "acme", company: "Acme Corp" };
const fastFetch = { sleep: async () => {}, baseDelayMs: 0 };

describe("parseGreenhouseListings", () => {
  it("reports every raw entry as fetched, independent of filtering", () => {
    expect(parseGreenhouseListings(greenhouseSampleResponse, board).fetched).toBe(7);
  });

  it("keeps only title-signalled internships; rejects 'Internal', boilerplate mentions, blank titles and id-less entries", () => {
    const { listings } = parseGreenhouseListings(greenhouseSampleResponse, board);
    expect(listings.map((l) => l.title)).toEqual(["Software Engineering Intern", "Data Science Internship"]);
  });

  it("maps fields into the canonical shape", () => {
    const l = parseGreenhouseListings(greenhouseSampleResponse, board).listings[0];
    expect(l.source_type).toBe("job_board");
    expect(l.source_name).toBe("greenhouse");
    expect(l.source_ref).toBe("acme:4001"); // board-scoped so ids can never collide across companies
    expect(l.company).toBe("Acme Corp");
    expect(l.employment_type).toBe("internship");
    expect(l.location).toBe("Remote - India");
    expect(l.work_mode).toBe("remote");
    expect(l.posted_date).toBe("2026-10-01");
    expect(l.application_url).toBe("https://boards.greenhouse.io/acme/jobs/4001");
    expect(l.source_url).toBe(l.application_url);
    expect(l.deadline_date).toBeNull();
  });

  it("decodes entity-escaped HTML into clean text and extracts skills from it", () => {
    const l = parseGreenhouseListings(greenhouseSampleResponse, board).listings[0];
    expect(l.description).not.toMatch(/[<>]/);
    expect(l.description).toContain("Python & Django");
    expect(l.skills).toEqual(expect.arrayContaining(["python", "django", "react"]));
  });

  it("extracts the sponsorship signal; every other eligibility column stays null", () => {
    const l = parseGreenhouseListings(greenhouseSampleResponse, board).listings[0];
    expect(l.sponsorship_offered).toBe(true);
    expect(l.jurisdiction_country).toBeNull();
    expect(l.eligible_candidate_countries).toBeNull();
    expect(l.required_degree_types).toBeNull();
    expect(l.graduation_not_after).toBeNull();
  });

  it("handles missing description, null location and falls back to updated_at for the date", () => {
    const l = parseGreenhouseListings(greenhouseSampleResponse, board).listings[1];
    expect(l.description).toBeNull();
    expect(l.work_mode).toBeNull(); // "Bengaluru, India" has no explicit work-mode word
    expect(l.posted_date).toBe("2026-10-03");
  });

  it("returns an empty result for malformed input instead of throwing", () => {
    for (const bad of [null, undefined, {}, [], "x", { jobs: "nope" }]) {
      expect(parseGreenhouseListings(bad, board)).toEqual({ listings: [], fetched: 0 });
    }
  });
});

describe("createGreenhouseAdapter", () => {
  it("fetches each configured board, tags listings with the right company, and isolates a 404 board", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/boards/acme/")) return new Response(JSON.stringify(greenhouseSampleResponse), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const adapter = createGreenhouseAdapter({
      boards: [
        { slug: "acme", company: "Acme Corp" },
        { slug: "ghost", company: "Ghost Inc" },
      ],
      fetchOptions: { ...fastFetch, fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    const result = await adapter.run();
    expect(result.sourceName).toBe("greenhouse");
    expect(result.listings).toHaveLength(2);
    expect(result.keptAfterFilter).toBe(2);
    expect(result.fetched).toBe(7);
    expect(result.errors).toEqual(["greenhouse/ghost: board not found (check the slug in ats-boards.json)"]);
    // Request URL shape: the documented endpoint with content=true.
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
    // 404 is not retried.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a clear skip (not a throw) when no boards are configured", async () => {
    const adapter = createGreenhouseAdapter({ boards: [] });
    const result = await adapter.run();
    expect(result.listings).toEqual([]);
    expect(result.errors[0]).toMatch(/no company boards configured/);
  });

  it("reads the boards file when no boards are injected, reporting only its own ATS's warnings", async () => {
    // A missing file → empty config + a file-level warning, reported as a skip.
    const adapter = createGreenhouseAdapter({ env: { ATS_BOARDS_FILE: "/definitely/not/here.json" } as NodeJS.ProcessEnv });
    const result = await adapter.run();
    expect(result.fetched).toBe(0);
    expect(result.errors.join(" ")).toMatch(/file not found/);
    expect(result.errors.join(" ")).toMatch(/no company boards configured/);
  });

  it("encodes the slug in the request URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
    const adapter = createGreenhouseAdapter({
      boards: [{ slug: "we ird", company: "Weird" }], // bypasses config validation on purpose
      fetchOptions: { ...fastFetch, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    await adapter.run();
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/boards/we%20ird/jobs");
  });

  it("caps the number of reported board errors", async () => {
    const boards = Array.from({ length: 20 }, (_, i) => ({ slug: `b${i}`, company: `B${i}` }));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }));
    const adapter = createGreenhouseAdapter({ boards, fetchOptions: { ...fastFetch, fetchImpl: fetchImpl as unknown as typeof fetch } });
    const result = await adapter.run();
    expect(result.errors).toHaveLength(16); // 15 board errors + one summary line
    expect(result.errors[15]).toMatch(/5 more board errors/);
  });
});
