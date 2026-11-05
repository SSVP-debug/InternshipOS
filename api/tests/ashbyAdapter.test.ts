import { describe, it, expect, vi } from "vitest";
import { createAshbyAdapter, parseAshbyListings } from "../src/lib/ingestion/adapters/ashbyAdapter.js";
import { ashbySampleResponse } from "./fixtures/atsBoardSamples.js";

const board = { slug: "acme", company: "Acme Corp" };

describe("parseAshbyListings", () => {
  it("reports every raw job as fetched", () => {
    expect(parseAshbyListings(ashbySampleResponse, board).fetched).toBe(5);
  });

  it("keeps structured employmentType=Intern and title-signalled internships; drops full-time roles, unlisted and id-less jobs", () => {
    const { listings } = parseAshbyListings(ashbySampleResponse, board);
    expect(listings.map((l) => l.title)).toEqual(["Product Engineer", "Frontend Engineering Intern"]);
  });

  it("maps fields and work mode from workplaceType, then isRemote", () => {
    const [first, second] = parseAshbyListings(ashbySampleResponse, board).listings;
    expect(first.source_name).toBe("ashby");
    expect(first.source_ref).toBe("acme:aaaaaaaa-0000-4000-8000-000000000001");
    expect(first.work_mode).toBe("hybrid");
    expect(first.posted_date).toBe("2026-09-20");
    expect(first.application_url).toBe(
      "https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-4000-8000-000000000001/application"
    );
    expect(first.skills).toEqual(expect.arrayContaining(["typescript", "postgresql"]));
    expect(second.work_mode).toBe("remote"); // from isRemote
    expect(second.application_url).toBe(second.source_url); // no applyUrl → jobUrl
    expect(second.description).toBeNull();
  });

  it("returns an empty result for malformed input instead of throwing", () => {
    for (const bad of [null, undefined, [], "x", { jobs: {} }]) {
      expect(parseAshbyListings(bad, board)).toEqual({ listings: [], fetched: 0 });
    }
  });
});

describe("createAshbyAdapter", () => {
  it("requests the documented endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(ashbySampleResponse), { status: 200 }));
    const adapter = createAshbyAdapter({
      boards: [board],
      fetchOptions: { sleep: async () => {}, baseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const result = await adapter.run();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.ashbyhq.com/posting-api/job-board/acme");
    expect(result.sourceName).toBe("ashby");
    expect(result.listings).toHaveLength(2);
  });
});
