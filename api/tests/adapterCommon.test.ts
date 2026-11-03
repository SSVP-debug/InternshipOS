import { describe, it, expect, vi } from "vitest";
import {
  HttpStatusError,
  decodeHtmlEntities,
  fetchJsonWithRetry,
  htmlToBoundedText,
  loadAtsBoardsConfig,
  mapWithConcurrency,
  parseAtsBoardsConfig,
  workModeFromLocationText,
  MAX_DESCRIPTION_CHARS,
} from "../src/lib/ingestion/adapters/adapterCommon.js";

const noSleep = async () => {};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("fetchJsonWithRetry", () => {
  it("returns parsed JSON on a 200", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: 1 }));
    await expect(fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep: noSleep })).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 and succeeds on the next attempt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: 2 }));
    await expect(fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep: noSleep })).resolves.toEqual({ ok: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network error and succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ ok: 3 }));
    await expect(fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep: noSleep })).resolves.toEqual({ ok: 3 });
  });

  it("does NOT retry a 404 and throws HttpStatusError with the status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 404));
    const error = await fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep: noSleep }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries attempts on persistent 503 and throws the last error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const error = await fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep: noSleep, maxRetries: 3 }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After (seconds) on a 429 as the wait before the next attempt", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse({ ok: 4 }));
    await fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("uses exponential backoff between attempts when there is no Retry-After", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    await fetchJsonWithRetry("https://example.com/a", { fetchImpl, sleep, baseDelayMs: 100, maxRetries: 3 }).catch(() => {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the concurrency limit and preserves input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(result).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list", async () => {
    await expect(mapWithConcurrency([], 4, async (n: number) => n)).resolves.toEqual([]);
  });
});

describe("text helpers", () => {
  it("decodes the entity-escaped HTML Greenhouse returns, without double-decoding &amp;", () => {
    expect(decodeHtmlEntities("&lt;p&gt;A &amp;amp; B&lt;/p&gt;")).toBe("<p>A &amp; B</p>");
    expect(decodeHtmlEntities("it&#39;s &#x41;")).toBe("it's A");
    expect(decodeHtmlEntities("bad &#99999999999; code")).toBe("bad   code");
  });

  it("converts escaped HTML to bounded plain text", () => {
    expect(htmlToBoundedText("&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;")).toBe("Hello world");
    expect(htmlToBoundedText("")).toBeNull();
    expect(htmlToBoundedText(null)).toBeNull();
    expect(htmlToBoundedText("x".repeat(MAX_DESCRIPTION_CHARS + 500))).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it("derives work mode only from an explicit word", () => {
    expect(workModeFromLocationText("Remote - India")).toBe("remote");
    expect(workModeFromLocationText("Hybrid (Bengaluru)")).toBe("hybrid");
    expect(workModeFromLocationText("Bengaluru")).toBeNull();
    expect(workModeFromLocationText(null)).toBeNull();
  });
});

describe("parseAtsBoardsConfig", () => {
  it("accepts slug strings and {slug, company} objects, derives a company name from the slug", () => {
    const { config, warnings } = parseAtsBoardsConfig({
      greenhouse: ["stripe", { slug: "gitlab", company: "GitLab" }, "my-startup"],
      lever: ["spotify"],
    });
    expect(warnings).toEqual([]);
    expect(config.greenhouse).toEqual([
      { slug: "stripe", company: "Stripe" },
      { slug: "gitlab", company: "GitLab" },
      { slug: "my-startup", company: "My Startup" },
    ]);
    expect(config.lever).toEqual([{ slug: "spotify", company: "Spotify" }]);
    expect(config.ashby).toEqual([]);
  });

  it("skips invalid slugs (path/URL injection attempts) with a warning, and de-duplicates", () => {
    const { config, warnings } = parseAtsBoardsConfig({
      greenhouse: ["good", "good", "../evil", "a/b", "has space", "", 42, { company: "No Slug" }, "q?x=1"],
    });
    expect(config.greenhouse.map((b) => b.slug)).toEqual(["good"]);
    expect(warnings.filter((w) => w.startsWith("greenhouse: skipping invalid")).length).toBe(7);
  });

  it("ignores a non-array section and a non-object root, with warnings", () => {
    expect(parseAtsBoardsConfig({ lever: "spotify" }).warnings[0]).toMatch(/^lever: expected an array/);
    expect(parseAtsBoardsConfig([]).warnings[0]).toMatch(/must be a JSON object/);
    expect(parseAtsBoardsConfig(null).config).toEqual({ greenhouse: [], lever: [], ashby: [] });
  });
});

describe("loadAtsBoardsConfig", () => {
  it("returns an empty config plus a warning when the file is missing", async () => {
    const readFileImpl = vi.fn(async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    });
    const result = await loadAtsBoardsConfig({ ATS_BOARDS_FILE: "/tmp/none.json" } as NodeJS.ProcessEnv, readFileImpl);
    expect(result.config.greenhouse).toEqual([]);
    expect(result.warnings[0]).toMatch(/file not found/);
    expect(result.filePath).toBe("/tmp/none.json");
  });

  it("returns an empty config plus a warning for invalid JSON instead of throwing", async () => {
    const result = await loadAtsBoardsConfig({} as NodeJS.ProcessEnv, async () => "{ not json");
    expect(result.config.lever).toEqual([]);
    expect(result.warnings[0]).toMatch(/not valid JSON/);
  });

  it("parses a valid file and honors ATS_BOARDS_FILE", async () => {
    const readFileImpl = vi.fn(async () => JSON.stringify({ ashby: ["ramp"] }));
    const result = await loadAtsBoardsConfig({ ATS_BOARDS_FILE: "/tmp/boards.json" } as NodeJS.ProcessEnv, readFileImpl);
    expect(readFileImpl).toHaveBeenCalledWith("/tmp/boards.json", "utf8");
    expect(result.config.ashby).toEqual([{ slug: "ramp", company: "Ramp" }]);
  });
});
