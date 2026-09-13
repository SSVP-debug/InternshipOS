import { describe, it, expect, vi, afterEach } from "vitest";
import { parseLeverPostingUrl, getLeverPosting, submitLeverApplication } from "../src/lib/ats/leverAdapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseLeverPostingUrl", () => {
  const POSTING_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

  it("parses a bare hosted posting URL", () => {
    const ref = parseLeverPostingUrl(`https://jobs.lever.co/acme/${POSTING_ID}`);
    expect(ref).toEqual({ site: "acme", postingId: POSTING_ID });
  });

  it("parses a posting URL with a trailing /apply and query string", () => {
    const ref = parseLeverPostingUrl(`https://jobs.lever.co/acme/${POSTING_ID}/apply?source=internshipos`);
    expect(ref).toEqual({ site: "acme", postingId: POSTING_ID });
  });

  it("tolerates surrounding whitespace", () => {
    const ref = parseLeverPostingUrl(`  https://jobs.lever.co/acme/${POSTING_ID}  `);
    expect(ref).toEqual({ site: "acme", postingId: POSTING_ID });
  });

  it("returns null for a non-Lever URL", () => {
    expect(parseLeverPostingUrl("https://boards.greenhouse.io/acme/jobs/12345")).toBeNull();
  });

  it("returns null for a Lever-lookalike URL missing a valid posting id", () => {
    expect(parseLeverPostingUrl("https://jobs.lever.co/acme/not-a-uuid")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseLeverPostingUrl("")).toBeNull();
  });
});

describe("getLeverPosting", () => {
  const REF = { site: "acme", postingId: "a1b2c3d4-e5f6-4789-a012-3456789abcde" };

  it("returns the posting on a successful, well-formed response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: REF.postingId, text: "Software Intern", state: "published", hostedUrl: "https://jobs.lever.co/acme/x" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getLeverPosting(REF);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.posting.state).toBe("published");
      expect(result.posting.text).toBe("Software Intern");
    }
    // Confirms the exact endpoint/shape this adapter is documented to call.
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.lever.co/v0/postings/acme/${REF.postingId}?mode=json`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("surfaces a 404 (removed/expired posting) as a failed result, not a thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );

    const result = await getLeverPosting(REF);
    expect(result).toEqual({ ok: false, status: 404, message: expect.stringContaining("404") });
  });

  it("treats a malformed 2xx body as a failure rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 })),
    );

    const result = await getLeverPosting(REF);
    expect(result.ok).toBe(false);
  });

  it("surfaces a network failure as a failed result rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.lever.co");
      }),
    );

    const result = await getLeverPosting(REF);
    expect(result).toEqual({ ok: false, status: 0, message: expect.stringContaining("ENOTFOUND") });
  });
});

describe("submitLeverApplication", () => {
  const REF = { site: "acme", postingId: "a1b2c3d4-e5f6-4789-a012-3456789abcde" };
  const INPUT = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1-555-0100",
    comments: "Excited about this role.",
    resumeFile: { bytes: new TextEncoder().encode("%PDF-fake").buffer, filename: "resume.pdf", contentType: "application/pdf" },
  };

  it("posts multipart form data to the posting's apply endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitLeverApplication(REF, INPUT);

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.lever.co/v0/postings/acme/${REF.postingId}`);
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("name")).toBe("Ada Lovelace");
    expect(form.get("email")).toBe("ada@example.com");
    expect(form.get("phone")).toBe("+1-555-0100");
    expect(form.get("comments")).toBe("Excited about this role.");
    const resumeEntry = form.get("resume") as File;
    expect(resumeEntry.name).toBe("resume.pdf");
    expect(resumeEntry.type).toBe("application/pdf");
  });

  it("omits optional fields entirely rather than sending empty strings", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitLeverApplication(REF, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      resumeFile: INPUT.resumeFile,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.has("phone")).toBe(false);
    expect(form.has("comments")).toBe(false);
  });

  it("surfaces a non-2xx response as a failed result with Lever's own body text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Missing required field: phone", { status: 422 })),
    );

    const result = await submitLeverApplication(REF, INPUT);
    expect(result).toEqual({ ok: false, status: 422, message: "Missing required field: phone" });
  });

  it("surfaces a network failure as a failed result rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    const result = await submitLeverApplication(REF, INPUT);
    expect(result).toEqual({ ok: false, status: 0, message: "socket hang up" });
  });
});
