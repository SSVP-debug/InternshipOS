import { describe, it, expect } from "vitest";
import { extractBearerToken } from "../src/middleware/auth.js";
import { loadEnv } from "../src/lib/env.js";

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the Bearer keyword", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null when the header is missing", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null when the header has no Bearer prefix", () => {
    expect(extractBearerToken("abc123")).toBeNull();
  });

  it("returns null for an empty header", () => {
    expect(extractBearerToken("")).toBeNull();
  });
});

describe("loadEnv", () => {
  const validEnv = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  };

  it("loads successfully with all required vars present", () => {
    const env = loadEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.SUPABASE_URL).toBe(validEnv.SUPABASE_URL);
    expect(env.PORT).toBe(3000); // default applied
  });

  it("throws a clear error when SUPABASE_URL is missing", () => {
    const { SUPABASE_URL, ...rest } = validEnv;
    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(/SUPABASE_URL/);
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    const { SUPABASE_SERVICE_ROLE_KEY, ...rest } = validEnv;
    expect(() => loadEnv(rest as NodeJS.ProcessEnv)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("defaults NODE_ENV to development when unset", () => {
    const env = loadEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects an invalid NODE_ENV value", () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: "staging" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /NODE_ENV/
    );
  });

  it("defaults ALLOWED_ORIGINS to an empty array when unset", () => {
    const env = loadEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.ALLOWED_ORIGINS).toEqual([]);
  });

  it("parses a comma-separated ALLOWED_ORIGINS into a trimmed array", () => {
    const env = loadEnv({
      ...validEnv,
      ALLOWED_ORIGINS: "https://a.example, https://b.example ,https://c.example",
    } as NodeJS.ProcessEnv);
    expect(env.ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
  });

  it("drops empty entries from ALLOWED_ORIGINS (e.g. a trailing comma)", () => {
    const env = loadEnv({ ...validEnv, ALLOWED_ORIGINS: "https://a.example,," } as NodeJS.ProcessEnv);
    expect(env.ALLOWED_ORIGINS).toEqual(["https://a.example"]);
  });

  it("applies sane defaults for rate-limit configuration", () => {
    const env = loadEnv(validEnv as NodeJS.ProcessEnv);
    expect(env.SIGNUP_RATE_LIMIT_MAX).toBe(10);
    expect(env.RATE_LIMIT_WINDOW_MINUTES).toBe(15);
  });

  it("respects an explicit SIGNUP_RATE_LIMIT_MAX", () => {
    const env = loadEnv({ ...validEnv, SIGNUP_RATE_LIMIT_MAX: "5" } as unknown as NodeJS.ProcessEnv);
    expect(env.SIGNUP_RATE_LIMIT_MAX).toBe(5);
  });
});
