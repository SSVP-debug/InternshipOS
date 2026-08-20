import { describe, it, expect, vi, afterEach } from "vitest";
import { checkReadiness } from "../src/lib/health.js";

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-key" };

describe("checkReadiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ready when Supabase responds with a non-5xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    );

    const result = await checkReadiness(env);
    expect(result.ready).toBe(true);
    expect(result.checks.database).toBe("ok");
  });

  it("reports not ready when Supabase responds with a 5xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    );

    const result = await checkReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe("unreachable");
  });

  it("reports not ready when the request throws (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await checkReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe("unreachable");
  });

  it("never includes the Supabase URL or key in its result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    );

    const result = await checkReadiness(env);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(env.SUPABASE_URL);
    expect(serialized).not.toContain(env.SUPABASE_ANON_KEY);
  });
});
