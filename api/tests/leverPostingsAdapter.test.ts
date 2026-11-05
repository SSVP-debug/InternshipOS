import { describe, it, expect, vi } from "vitest";
import { createLeverPostingsAdapter, parseLeverListings } from "../src/lib/ingestion/adapters/leverPostingsAdapter.js";
import { leverSampleResponse } from "./fixtures/atsBoardSamples.js";

const board = { slug: "acme", company: "Acme Corp" };

describe("parseLeverListings", () => {
  it("reports every raw array element as fetched", () => {
    expect(parseLeverListings(leverSampleResponse, board).fetched).toBe(5);
  });

  it("keeps title-signalled AND commitment-signalled internships, drops full-time roles and id-less entries", () => {
    const { listings } = parseLeverListings(leverSampleResponse, board);
    expect(listings.map((l) => l.title)).toEqual(["Backend Engineer Intern", "Machine Learning Engineer (Summer)"]);
  });

  it("maps fields, converting epoch-milliseconds createdAt into a YYYY-MM-DD date", () => {
    const l = parseLeverListings(leverSampleResponse, board).listings[0];
    expect(l.source_name).toBe("lever");
    expect(l.source_ref).toBe("acme:11111111-1111-4111-8111-111111111111");
    expect(l.company).toBe("Acme Corp");
    expect(l.work_mode).toBe("remote");
    expect(l.posted_date).toBe("2025-10-09");
    expect(l.source_url).toBe("https://jobs.lever.co/acme/11111111-1111-4111-8111-111111111111");
    expect(l.application_url).toBe("https://jobs.lever.co/acme/11111111-1111-4111-8111-111111111111/apply");
    expect(l.sponsorship_offered).toBe(false); // "will not offer visa sponsorship"
    expect(l.skills).toEqual(expect.arrayContaining(["node"]));
  });

  it("treats workplaceType 'unspecified' as not stated and falls back to hostedUrl for the apply link", () => {
    const l = parseLeverListings(leverSampleResponse, board).listings[1];
    expect(l.work_mode).toBeNull();
    expect(l.application_url).toBe(l.source_url);
    expect(l.location).toBe("Hyderabad, India");
  });

  it("returns an empty result for malformed input instead of throwing", () => {
    for (const bad of [null, undefined, {}, "x", { postings: [] }]) {
      expect(parseLeverListings(bad, board)).toEqual({ listings: [], fetched: 0 });
    }
  });
});

describe("createLeverPostingsAdapter", () => {
  it("requests the documented endpoint and returns parsed listings", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(leverSampleResponse), { status: 200 }));
    const adapter = createLeverPostingsAdapter({
      boards: [board],
      fetchOptions: { sleep: async () => {}, baseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const result = await adapter.run();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.lever.co/v0/postings/acme?mode=json");
    expect(result.sourceName).toBe("lever");
    expect(result.listings).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("reports an HTTP failure as a per-board error and still resolves", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
    const adapter = createLeverPostingsAdapter({
      boards: [board],
      fetchOptions: { sleep: async () => {}, baseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const result = await adapter.run();
    expect(result.listings).toEqual([]);
    expect(result.errors[0]).toMatch(/^lever\/acme: HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 5xx is retried up to the default attempts
  });
});
