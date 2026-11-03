import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdzunaAdapter, readMaxPages } from "../src/lib/ingestion/adapters/adzunaAdapter.js";

const ENV = { ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key" };

/** Builds one Adzuna page: `count` results, all internship-titled, ids unique per page. */
function page(pageNumber: number, count: number): Response {
  const results = Array.from({ length: count }, (_, i) => ({
    id: `p${pageNumber}-${i}`,
    title: `Software Intern ${pageNumber}-${i}`,
    company: { display_name: "Acme" },
    description: "A great internship.",
    location: { display_name: "Pune" },
    redirect_url: `https://example.com/${pageNumber}-${i}`,
    created: "2026-10-01T00:00:00Z",
  }));
  return new Response(JSON.stringify({ results }), { status: 200 });
}

describe("readMaxPages", () => {
  it("defaults to 10, parses valid values, clamps to 40, and ignores garbage", () => {
    expect(readMaxPages({} as NodeJS.ProcessEnv)).toBe(10);
    expect(readMaxPages({ ADZUNA_MAX_PAGES: "3" } as NodeJS.ProcessEnv)).toBe(3);
    expect(readMaxPages({ ADZUNA_MAX_PAGES: "500" } as NodeJS.ProcessEnv)).toBe(40);
    expect(readMaxPages({ ADZUNA_MAX_PAGES: "0" } as NodeJS.ProcessEnv)).toBe(10);
    expect(readMaxPages({ ADZUNA_MAX_PAGES: "abc" } as NodeJS.ProcessEnv)).toBe(10);
    expect(readMaxPages({ ADZUNA_MAX_PAGES: "" } as NodeJS.ProcessEnv)).toBe(10);
  });
});

describe("createAdzunaAdapter — paging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps paging past the old 2-page cap until a short page signals the end of the results", async () => {
    // 3 full pages (50 each) then a short page of 7 → 157 results, 4 requests.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const n = Number(String(url).match(/search\/(\d+)\?/)?.[1]);
      return page(n, n <= 3 ? 50 : 7);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAdzunaAdapter(ENV as NodeJS.ProcessEnv).run();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.fetched).toBe(157);
    expect(result.listings).toHaveLength(157);
    expect(result.errors).toEqual([]);
  });

  it("respects ADZUNA_MAX_PAGES and reports that more results may exist when the last page was full", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => page(Number(String(url).match(/search\/(\d+)\?/)?.[1]), 50));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAdzunaAdapter({ ...ENV, ADZUNA_MAX_PAGES: "3" } as NodeJS.ProcessEnv).run();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.listings).toHaveLength(150);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/3-page limit/);
    expect(result.errors[0]).toMatch(/ADZUNA_MAX_PAGES/);
  });

  it("stops after the first page when it is already short, with no limit notice", async () => {
    const fetchMock = vi.fn(async () => page(1, 12));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAdzunaAdapter(ENV as NodeJS.ProcessEnv).run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.listings).toHaveLength(12);
    expect(result.errors).toEqual([]);
  });
});
