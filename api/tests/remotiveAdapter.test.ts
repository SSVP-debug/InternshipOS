import { describe, it, expect, vi } from "vitest";
import { createRemotiveAdapter, parseRemotiveListings } from "../src/lib/ingestion/adapters/remotiveAdapter.js";
import { remotiveSampleResponse } from "./fixtures/atsBoardSamples.js";

describe("parseRemotiveListings", () => {
  it("reports the raw job count as fetched", () => {
    expect(parseRemotiveListings(remotiveSampleResponse).fetched).toBe(5);
  });

  it("keeps internships by title, description or job_type; drops non-internships, company-less and id-less entries", () => {
    const { listings } = parseRemotiveListings(remotiveSampleResponse);
    // 2002's description mentions "internship program" so the shared description check keeps it,
    // exactly as it does for Adzuna/RemoteOK; 2003 passes on job_type alone.
    expect(listings.map((l) => l.source_ref)).toEqual(["2001", "2002", "2003"]);
  });

  it("maps fields: remote-only, Remotive page as the link-back URL, source tags merged into skills", () => {
    const l = parseRemotiveListings(remotiveSampleResponse).listings[0];
    expect(l.source_name).toBe("remotive");
    expect(l.company).toBe("Orbit Labs");
    expect(l.work_mode).toBe("remote");
    expect(l.location).toBe("Worldwide");
    expect(l.posted_date).toBe("2026-10-10");
    expect(l.application_url).toBe("https://remotive.com/remote-jobs/software-dev/python-intern-2001");
    expect(l.skills).toEqual(expect.arrayContaining(["python", "django"]));
    expect(l.description).not.toMatch(/<[^>]*>/);
    expect(l.sponsorship_offered).toBe(false);
  });

  it("keeps the location text for display but maps NO eligibility country (residency preference ≠ citizenship)", () => {
    const l = parseRemotiveListings(remotiveSampleResponse).listings[1];
    expect(l.location).toBe("USA Only");
    expect(l.jurisdiction_country).toBeNull();
    expect(l.eligible_candidate_countries).toBeNull();
  });

  it("defaults an empty location to 'Remote'", () => {
    expect(parseRemotiveListings(remotiveSampleResponse).listings[2].location).toBe("Remote");
  });

  it("returns an empty result for malformed input instead of throwing", () => {
    for (const bad of [null, undefined, [], {}, { jobs: "x" }]) {
      expect(parseRemotiveListings(bad)).toEqual({ listings: [], fetched: 0 });
    }
  });
});

describe("createRemotiveAdapter", () => {
  it("makes exactly one request per run to the documented endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(remotiveSampleResponse), { status: 200 }));
    const adapter = createRemotiveAdapter({ sleep: async () => {}, baseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter.run();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://remotive.com/api/remote-jobs?search=intern");
    expect(result.listings).toHaveLength(3);
    expect(result.errors).toEqual([]);
  });

  it("resolves with the error reported when the request fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }));
    const adapter = createRemotiveAdapter({ sleep: async () => {}, baseDelayMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await adapter.run();
    expect(result.listings).toEqual([]);
    expect(result.errors[0]).toMatch(/HTTP 404/);
  });
});
