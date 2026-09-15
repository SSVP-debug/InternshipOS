import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import type { Env } from "../src/lib/env.js";
import { applicationRouter } from "../src/routes/application.js";

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

const APP_ID = "44444444-4444-4444-8444-444444444444";
const OPP_ID = "55555555-5555-4555-8555-555555555555";
const RESUME_ID = "66666666-6666-4666-8666-666666666666";

const TEST_ENV: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  PORT: 3000,
  CONSENT_POLICY_VERSION: "v1.0",
  NODE_ENV: "test",
  RATE_LIMIT_WINDOW_MINUTES: 15,
  SIGNUP_RATE_LIMIT_MAX: 5,
  EXTERNAL_ATS_SUBMISSION_ENABLED: false, // this route has no kill switch — it never contacts anything external
};

function getHandler() {
  const router = applicationRouter(TEST_ENV) as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === "/applications/:id/cover-letter-draft" && l.route?.methods.get);
  if (!layer?.route) throw new Error("no route registered for GET /applications/:id/cover-letter-draft");
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(
  handlers: ((req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown)[],
  req: AuthedRequest,
  res: Response,
) {
  let index = 0;
  const next = async (err?: unknown) => {
    if (err) throw err;
    index++;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await handlers[0](req, res, next);
}

function makeRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  return res;
}

interface MockOpts {
  applicationFetch?: { data: unknown; error: unknown };
  opportunityFetch?: { data: unknown; error: unknown };
  personalInfoFetch?: { data: unknown; error: unknown };
  resumeFetch?: { data: unknown; error: unknown };
  resumeSkillLinks?: { data: unknown; error: unknown };
  skillRows?: { data: unknown; error: unknown };
}

function makeSupabaseMock(opts: MockOpts = {}) {
  const {
    applicationFetch = { data: { id: APP_ID, resume_id: RESUME_ID, opportunity_id: OPP_ID }, error: null },
    opportunityFetch = { data: { title: "Software Engineering Intern", company: "Acme Corp" }, error: null },
    personalInfoFetch = { data: { legal_first_name: "Ada", legal_last_name: "Lovelace" }, error: null },
    resumeFetch = { data: { label: "Software Development" }, error: null },
    resumeSkillLinks = { data: [{ skill_id: "s1" }, { skill_id: "s2" }], error: null },
    skillRows = { data: [{ name: "Python" }, { name: "SQL" }], error: null },
  } = opts;

  return {
    from(table: string) {
      if (table === "application") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => applicationFetch }) }) };
      }
      if (table === "opportunity") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => opportunityFetch }) }) };
      }
      if (table === "personal_info") {
        return { select: () => ({ maybeSingle: async () => personalInfoFetch }) };
      }
      if (table === "resume") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => resumeFetch }) }) };
      }
      if (table === "resume_skill") {
        return { select: () => ({ eq: async () => resumeSkillLinks }) };
      }
      if (table === "skill") {
        return { select: () => ({ in: async () => skillRows }) };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
  };
}

describe("GET /applications/:id/cover-letter-draft", () => {
  it("returns a draft mentioning the opportunity title, company, candidate name, resume label, and skills", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: APP_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandler(), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res as unknown as { body: { draft: string } }).body;
    expect(body.draft).toContain("Software Engineering Intern");
    expect(body.draft).toContain("Acme Corp");
    expect(body.draft).toContain("Ada Lovelace");
    expect(body.draft).toContain("Software Development");
    expect(body.draft).toContain("Python and SQL");
  });

  it("still returns a draft (with placeholder name) when personal_info is missing, rather than failing", async () => {
    const supabase = makeSupabaseMock({ personalInfoFetch: { data: null, error: null } });
    const req = { supabase, params: { id: APP_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandler(), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res as unknown as { body: { draft: string } }).body;
    expect(body.draft).toContain("[Your name]");
  });

  it("skips the resume/skills lookups entirely when the application has no resume_id", async () => {
    const supabase = makeSupabaseMock({ applicationFetch: { data: { id: APP_ID, resume_id: null, opportunity_id: OPP_ID }, error: null } });
    const req = { supabase, params: { id: APP_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandler(), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res as unknown as { body: { draft: string } }).body;
    expect(body.draft).not.toContain("resume");
    expect(body.draft).not.toContain("Python");
  });

  it("returns 404 when the application doesn't exist (or isn't the caller's own, via RLS)", async () => {
    const supabase = makeSupabaseMock({ applicationFetch: { data: null, error: null } });
    const req = { supabase, params: { id: APP_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandler(), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 400 for a non-UUID id without ever touching the database", async () => {
    const supabase = makeSupabaseMock();
    const fromSpy = vi.spyOn(supabase, "from");
    const req = { supabase, params: { id: "not-a-uuid" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandler(), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(fromSpy).not.toHaveBeenCalled();
  });
});
