import { describe, it, expect } from "vitest";
import { parseRemoteOkListings } from "../src/lib/ingestion/adapters/remoteokAdapter.js";
import { remoteOkSampleResponse } from "./fixtures/remoteokSample.js";

describe("parseRemoteOkListings", () => {
  it("reports the raw entry count as fetched, independent of filtering", () => {
    const { fetched } = parseRemoteOkListings(remoteOkSampleResponse);
    expect(fetched).toBe(7); // all 7 raw entries in the fixture, including the legal notice
  });

  it("drops the leading legal-notice entry and any malformed entries", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    // Of 7 raw entries: 1 legal notice + 1 malformed (missing company) +
    // 1 non-internship posting are dropped -> 4 canonical listings remain.
    expect(listings).toHaveLength(4);
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

  it("A3.3: leaves jurisdiction_country null — remote-only has no single jurisdiction", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    expect(listings.length).toBeGreaterThan(0);
    for (const l of listings) {
      expect(l.jurisdiction_country).toBeNull();
    }
  });

  it("A3.3: extracts sponsorship_offered=true from an unambiguous explicit statement", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const devops = listings.find((l) => l.source_ref === "1010105");

    expect(devops).toBeDefined();
    expect(devops?.sponsorship_offered).toBe(true);
  });

  it("A3.3: extracts sponsorship_offered=false from an unambiguous explicit statement", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const design = listings.find((l) => l.source_ref === "1010106");

    expect(design).toBeDefined();
    expect(design?.sponsorship_offered).toBe(false);
  });

  it("A3.3: leaves sponsorship_offered null when the description says nothing about it", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const frontend = listings.find((l) => l.source_ref === "1010101");

    expect(frontend?.sponsorship_offered).toBeNull();
  });

  it("A3.3: leaves every other eligibility field null — no evidence exists in RemoteOK's response", () => {
    const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
    const frontend = listings.find((l) => l.source_ref === "1010101");

    expect(frontend?.citizenship_requirement).toBeNull();
    expect(frontend?.eligible_candidate_countries).toBeNull();
    expect(frontend?.citizenship_required_countries).toBeNull();
    expect(frontend?.requires_existing_work_authorization).toBeNull();
    expect(frontend?.required_degree_types).toBeNull();
    expect(frontend?.required_majors).toBeNull();
    expect(frontend?.required_major_match_mode).toBeNull();
    expect(frontend?.graduation_not_before).toBeNull();
    expect(frontend?.graduation_not_after).toBeNull();
    expect(frontend?.required_enrollment_statuses).toBeNull();
  });

  it("returns an empty result for a non-array input instead of throwing", () => {
    expect(parseRemoteOkListings(null)).toEqual({ listings: [], fetched: 0 });
    expect(parseRemoteOkListings(undefined)).toEqual({ listings: [], fetched: 0 });
    expect(parseRemoteOkListings({})).toEqual({ listings: [], fetched: 0 });
  });
});
