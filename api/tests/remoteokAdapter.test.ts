import { describe, it, expect } from "vitest";
import { parseRemoteOkListings } from "../src/lib/ingestion/adapters/remoteokAdapter.js";
import { remoteOkSampleResponse } from "./fixtures/remoteokSample.js";

describe("parseRemoteOkListings", () => {
  it("reports the raw entry count as fetched, independent of filtering", () => {
    const { fetched } = parseRemoteOkListings(remoteOkSampleResponse);
    expect(fetched).toBe(5); // all 5 raw entries in the fixture, including the legal notice
  });

  it("drops the leading legal-notice entry and any malformed entries", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    // Of 5 raw entries: 1 legal notice + 1 malformed (missing company) +
    // 1 non-internship posting are dropped -> 2 canonical listings remain.
    expect(listings).toHaveLength(2);
  });

  it("filters out non-internship postings", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const titles = listings.map((l) => l.title);
    expect(titles).not.toContain("Senior Backend Engineer");
  });

  it("keeps internship postings and maps fields into the canonical shape", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const frontend = listings.find((l) => l.source_ref === "1010101");

    expect(frontend).toBeDefined();
    expect(frontend?.source_type).toBe("job_board");
    expect(frontend?.source_name).toBe("remoteok");
    expect(frontend?.title).toBe("Frontend Engineering Intern");
    expect(frontend?.company).toBe("Nimbus Labs");
    expect(frontend?.work_mode).toBe("remote");
    expect(frontend?.employment_type).toBe("internship");
    expect(frontend?.skills).toContain("react");
    expect(frontend?.description).not.toMatch(/<[^>]*>/);
    expect(frontend?.posted_date).toBe("2026-08-10");
    expect(frontend?.application_url).toBe(
      "https://remoteok.com/remote-jobs/1010101-frontend-engineering-intern-nimbus-labs"
    );
  });

  it("defaults an empty location string to 'Remote'", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const dataScience = listings.find((l) => l.source_ref === "1010103");
    expect(dataScience?.location).toBe("Remote");
  });

  it("derives posted_date from epoch when date is absent", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const dataScience = listings.find((l) => l.source_ref === "1010103");
    expect(dataScience?.posted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns an empty result for a non-array input instead of throwing", () => {
    expect(parseRemoteOkListings(null)).toEqual({ listings: [], fetched: 0 });
    expect(parseRemoteOkListings(undefined)).toEqual({ listings: [], fetched: 0 });
    expect(parseRemoteOkListings({})).toEqual({ listings: [], fetched: 0 });
  });
});
