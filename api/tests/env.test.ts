import { describe, it, expect } from "vitest";
import { loadEnv } from "../src/lib/env.js";

const BASE_VALID_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("EXTERNAL_ATS_SUBMISSION_ENABLED", () => {
  it("defaults to false when unset", () => {
    const env = loadEnv({ ...BASE_VALID_ENV });
    expect(env.EXTERNAL_ATS_SUBMISSION_ENABLED).toBe(false);
  });

  it('parses the literal string "false" as false', () => {
    // Regression guard: z.coerce.boolean() would incorrectly parse this
    // as true (JS's Boolean("false") is true) — see env.ts's comment on
    // this field for why an explicit enum+transform is used instead.
    const env = loadEnv({ ...BASE_VALID_ENV, EXTERNAL_ATS_SUBMISSION_ENABLED: "false" });
    expect(env.EXTERNAL_ATS_SUBMISSION_ENABLED).toBe(false);
  });

  it('parses the literal string "true" as true', () => {
    const env = loadEnv({ ...BASE_VALID_ENV, EXTERNAL_ATS_SUBMISSION_ENABLED: "true" });
    expect(env.EXTERNAL_ATS_SUBMISSION_ENABLED).toBe(true);
  });

  it("rejects any other value rather than silently defaulting", () => {
    const parsed = (() => {
      try {
        loadEnv({ ...BASE_VALID_ENV, EXTERNAL_ATS_SUBMISSION_ENABLED: "yes" });
        return { threw: false };
      } catch {
        return { threw: true };
      }
    })();
    expect(parsed.threw).toBe(true);
  });
});
