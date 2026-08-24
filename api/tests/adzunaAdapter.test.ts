import { describe, it, expect, vi, afterEach } from "vitest";
import { parseAdzunaListings, createAdzunaAdapter } from "../src/lib/ingestion/adapters/adzunaAdapter.js";
import { adzunaSampleResponse } from "./fixtures/adzunaSample.js";

describe("parseAdzunaListings", () => {
  it("reports the raw result count as fetched, independent of filtering", () => {
    const { fetched } = parseAdzunaListings(adzunaSampleResponse);
    expect(fetched).toBe(5); // all 5 raw results returned by the API, before any filtering
  });

  it("drops non-internship postings and the malformed entry missing company", () => {
    const { listings } = parseAdzunaListings(adzunaSampleResponse);
    // Of 5 raw results: 1 malformed (missing company.display_name) and 2
    // non-internship postings are dropped -> 2 canonical listings remain.
    expect(listings).toHaveLength(2);
  });

  it("never treats 'International ...' as an internship match (word-boundary filter)", () => {
    const { listings } = parseAdzunaListings(adzunaSampleResponse);
    const titles = listings.map((l) => l.title);
    expect(titles).not.toContain("International Business Development Executive");
    expect(titles).not.toContain("Senior Software Engineer");
  });

  it("maps a matched listing into the canonical shape", () => {
    const { listings } = parseAdzunaListings(adzunaSampleResponse);
    const swIntern = listings.find((l) => l.source_ref === "4455667788");

    expect(swIntern).toBeDefined();
    expect(swIntern?.source_type).toBe("job_board");
    expect(swIntern?.source_name).toBe("adzuna");
    expect(swIntern?.title).toBe("Software Development Intern");
    expect(swIntern?.company).toBe("Kavali Systems Pvt Ltd");
    expect(swIntern?.location).toBe("Bengaluru, Karnataka");
    expect(swIntern?.employment_type).toBe("internship");
    expect(swIntern?.skills).toEqual([]); // Adzuna: no structured skills signal, never guessed
    expect(swIntern?.posted_date).toBe("2026-08-15");
    expect(swIntern?.application_url).toBe("https://www.adzuna.in/land/ad/4455667788");
  });

  it("infers work_mode only from an explicit remote/hybrid mention in the description", () => {
    const { listings } = parseAdzunaListings(adzunaSampleResponse);
    const hybridListing = listings.find((l) => l.source_ref === "4455667788");
    const remoteListing = listings.find((l) => l.source_ref === "4455667791");

    expect(hybridListing?.work_mode).toBe("hybrid");
    expect(remoteListing?.work_mode).toBe("remote");
  });

  it("returns an empty result when results is missing or not an array", () => {
    expect(parseAdzunaListings({})).toEqual({ listings: [], fetched: 0 });
    expect(parseAdzunaListings(null)).toEqual({ listings: [], fetched: 0 });
    expect(parseAdzunaListings({ results: "not-an-array" })).toEqual({ listings: [], fetched: 0 });
  });
});

describe("createAdzunaAdapter — missing credentials", () => {
  it("skips the run with a clear error instead of throwing when credentials are absent", async () => {
    const adapter = createAdzunaAdapter({} as NodeJS.ProcessEnv);
    const result = await adapter.run();

    expect(result.sourceName).toBe("adzuna");
    expect(result.fetched).toBe(0);
    expect(result.listings).toEqual([]);
    expect(result.errors[0]).toMatch(/ADZUNA_APP_ID/);
  });
});

describe("createAdzunaAdapter — non-2xx response handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes a sanitized request diagnostic (endpoint, path, non-secret params) and response body, with credentials fully redacted", async () => {
    const appId = "test-app-id-999";
    const appKey = "super-secret-app-key-12345";

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            exception: "InvalidAppIdOrKey",
            display: `Bad credentials for app_id=${appId}&app_key=${appKey}`,
          }),
          { status: 401 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdzunaAdapter({ ADZUNA_APP_ID: appId, ADZUNA_APP_KEY: appKey } as NodeJS.ProcessEnv);
    const result = await adapter.run();

    expect(result.listings).toEqual([]);
    expect(result.errors).toHaveLength(1);

    const combinedErrors = result.errors.join(" ");

    // Request diagnostic: exact endpoint host + path, and the non-secret
    // query parameters actually sent (what, results_per_page, content-type).
    expect(combinedErrors).toContain("https://api.adzuna.com/v1/api/jobs/in/search/1");
    expect(combinedErrors).toMatch(/what=internship/);
    expect(combinedErrors).toMatch(/results_per_page=50/);
    expect(combinedErrors).toMatch(/content-type=application(%2F|\/)json/);

    // Response body diagnostic: status and Adzuna's own error text visible...
    expect(combinedErrors).toMatch(/HTTP 401/);
    expect(combinedErrors).toMatch(/InvalidAppIdOrKey/);

    // ...but neither credential value, nor the raw app_id=/app_key= pairs,
    // may appear anywhere in the diagnostic — not in the request URL part,
    // not in the response body part, not even partially. The request-URL
    // portion is built via URLSearchParams, so its redaction marker is
    // percent-encoded ("%5Bredacted%5D"); the response-body portion is a
    // plain string replace, so its marker is literal ("[redacted]").
    // Either encoding is an accepted safe form — what must never appear is
    // an app_id=/app_key= pair followed by anything other than one of those
    // two redaction markers.
    const REDACTION_MARKER = "(?:\\[redacted\\]|%5Bredacted%5D)";
    expect(combinedErrors).not.toContain(appId);
    expect(combinedErrors).not.toContain(appKey);
    expect(combinedErrors).not.toMatch(new RegExp(`app_id=(?!${REDACTION_MARKER})`, "i"));
    expect(combinedErrors).not.toMatch(new RegExp(`app_key=(?!${REDACTION_MARKER})`, "i"));
    expect(combinedErrors).toMatch(/app_id=(?:\[redacted\]|%5Bredacted%5D)/i);
    expect(combinedErrors).toMatch(/app_key=(?:\[redacted\]|%5Bredacted%5D)/i);

    // Retry behavior is unchanged: 3 attempts against page 1, no page 2 call
    // once page 1 has failed all its retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
