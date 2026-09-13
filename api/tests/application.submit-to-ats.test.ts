import { describe, it, expect, vi, afterEach } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import type { Env } from "../src/lib/env.js";
import { applicationRouter } from "../src/routes/application.js";

// Deliberately a separate, self-contained test file rather than adding to
// application.route.test.ts's describe blocks — this route's mock needs
// (evidence_source, personal_info, storage.createSignedUrl, and mocked
// outbound fetch to Lever) don't overlap with that file's existing
// makeSupabaseMock, and bolting them on would risk destabilizing 21
// already-passing tests for a route change unrelated to them.

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
const EVIDENCE_ID = "77777777-7777-4777-8777-777777777777";
const LEVER_POSTING_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const LEVER_URL = `https://jobs.lever.co/acme/${LEVER_POSTING_ID}`;

const ENABLED_ENV: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  PORT: 3000,
  CONSENT_POLICY_VERSION: "v1.0",
  NODE_ENV: "test",
  RATE_LIMIT_WINDOW_MINUTES: 15,
  SIGNUP_RATE_LIMIT_MAX: 5,
  EXTERNAL_ATS_SUBMISSION_ENABLED: true,
};
const DISABLED_ENV: Env = { ...ENABLED_ENV, EXTERNAL_ATS_SUBMISSION_ENABLED: false };

function getSubmitHandler(env: Env) {
  const router = applicationRouter(env) as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === "/applications/:id/submit-to-ats" && l.route?.methods.post);
  if (!layer?.route) throw new Error("no route registered for POST /applications/:id/submit-to-ats");
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

function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.update = self;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

interface MockOpts {
  candidate?: { id: string } | null;
  applicationFetch?: { data: unknown; error: unknown };
  opportunityFetch?: { data: unknown; error: unknown };
  resumeFetch?: { data: unknown; error: unknown };
  evidenceSourceFetch?: { data: unknown; error: unknown };
  personalInfoFetch?: { data: unknown; error: unknown };
  signedUrlResult?: { data: unknown; error: unknown };
  applicationFinalUpdate?: { data: unknown; error: unknown };
  updateSpy?: ReturnType<typeof vi.fn<(patch: unknown) => unknown>>;
  insertSpy?: ReturnType<typeof vi.fn<(row: unknown) => unknown>>;
}

function makeSupabaseMock(opts: MockOpts = {}) {
  const {
    candidate = { id: "cand-1" },
    applicationFetch = { data: { id: APP_ID, status: "SAVED", resume_id: RESUME_ID, opportunity_id: OPP_ID }, error: null },
    opportunityFetch = { data: { id: OPP_ID, application_url: LEVER_URL }, error: null },
    resumeFetch = { data: { id: RESUME_ID, evidence_source_id: EVIDENCE_ID }, error: null },
    evidenceSourceFetch = { data: { source_type: "document_upload", file_ref: `cand-1/${EVIDENCE_ID}-resume.pdf`, title: "My Resume" }, error: null },
    personalInfoFetch = { data: { legal_first_name: "Ada", legal_last_name: "Lovelace", email: "ada@example.com", phone: "+1-555-0100" }, error: null },
    signedUrlResult = { data: { signedUrl: "https://storage.example/signed/resume.pdf" }, error: null },
    applicationFinalUpdate = { data: { id: APP_ID, status: "APPLIED" }, error: null },
    updateSpy = vi.fn(),
    insertSpy = vi.fn(),
  } = opts;

  let applicationSelectDone = false;

  return {
    from(table: string) {
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      if (table === "application") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => (applicationSelectDone ? applicationFinalUpdate : ((applicationSelectDone = true), applicationFetch)) }) }),
          update: (patch: unknown) => {
            updateSpy(patch);
            return chainable(applicationFinalUpdate);
          },
        };
      }
      if (table === "opportunity") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => opportunityFetch }) }) };
      }
      if (table === "resume") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => resumeFetch }) }) };
      }
      if (table === "evidence_source") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => evidenceSourceFetch }) }) };
      }
      if (table === "personal_info") {
        return { select: () => ({ maybeSingle: async () => personalInfoFetch }) };
      }
      if (table === "application_status_event") {
        return { insert: insertSpy.mockReturnValue(chainable({ data: null, error: null })) };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => signedUrlResult,
      }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockLeverFetch(postingState = "published") {
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("api.lever.co/v0/postings") && !url.includes("?mode=json") === false) {
      return new Response(JSON.stringify({ id: LEVER_POSTING_ID, text: "Software Intern", state: postingState, hostedUrl: LEVER_URL }), { status: 200 });
    }
    if (typeof url === "string" && url.includes("storage.example")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (typeof url === "string" && url === `https://api.lever.co/v0/postings/acme/${LEVER_POSTING_ID}`) {
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("POST /applications/:id/submit-to-ats", () => {
  it("returns 403 when EXTERNAL_ATS_SUBMISSION_ENABLED is off, regardless of anything else", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(DISABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("external_ats_submission_disabled");
  });

  it("dry_run defaults to true and never calls fetch at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // getLeverPosting is still called in dry-run mode (to validate the
    // posting is real/open before reporting what would be submitted), so
    // stub it to succeed.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: LEVER_POSTING_ID, text: "Software Intern", state: "published" }), { status: 200 }));

    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: APP_ID }, body: {} } as unknown as AuthedRequest; // no dry_run key at all
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res as unknown as { body: { dry_run: boolean; would_submit: Record<string, unknown> } }).body;
    expect(body.dry_run).toBe(true);
    expect(body.would_submit).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
    // getLeverPosting called once (GET), submitLeverApplication never called (no POST).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an opportunity whose application_url isn't a Lever posting", async () => {
    const supabase = makeSupabaseMock({ opportunityFetch: { data: { id: OPP_ID, application_url: "https://boards.greenhouse.io/acme/jobs/1" }, error: null } });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("unsupported_ats");
  });

  it("rejects when the resume has no attached document", async () => {
    const supabase = makeSupabaseMock({ resumeFetch: { data: { id: RESUME_ID, evidence_source_id: null }, error: null } });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("resume_missing_file");
  });

  it("rejects when personal_info is missing required fields", async () => {
    const supabase = makeSupabaseMock({ personalInfoFetch: { data: null, error: null } });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("personal_info_incomplete");
  });

  it("refuses to (re)submit an application that is already APPLIED or further along", async () => {
    const supabase = makeSupabaseMock({ applicationFetch: { data: { id: APP_ID, status: "INTERVIEW", resume_id: RESUME_ID, opportunity_id: OPP_ID }, error: null } });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("application_not_eligible_for_submission");
  });

  it("rejects when the live Lever posting is no longer published", async () => {
    mockLeverFetch("closed");
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: true } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("opportunity_closed");
  });

  it("on a real (dry_run: false) success, submits to Lever, advances SAVED -> APPLYING -> APPLIED, and records ats_provider", async () => {
    mockLeverFetch("published");
    const updateSpy = vi.fn();
    const insertSpy = vi.fn();
    const supabase = makeSupabaseMock({ updateSpy, insertSpy });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: false } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res as unknown as { body: { submitted: boolean } }).body;
    expect(body.submitted).toBe(true);

    // Two application.update calls: SAVED -> APPLYING, then the final
    // APPLIED update carrying ats_provider/ats_submitted_at.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0][0]).toEqual({ status: "APPLYING" });
    expect(updateSpy.mock.calls[1][0]).toMatchObject({ status: "APPLIED", ats_provider: "lever", ats_submission_error: null });

    // Two history events: SAVED->APPLYING, APPLYING->APPLIED.
    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ from_status: "SAVED", to_status: "APPLYING" });
    expect(insertSpy.mock.calls[1][0]).toMatchObject({ from_status: "APPLYING", to_status: "APPLIED" });
  });

  it("an application already in APPLYING skips straight to APPLIED (no redundant APPLYING update)", async () => {
    mockLeverFetch("published");
    const updateSpy = vi.fn();
    const insertSpy = vi.fn();
    const supabase = makeSupabaseMock({
      applicationFetch: { data: { id: APP_ID, status: "APPLYING", resume_id: RESUME_ID, opportunity_id: OPP_ID }, error: null },
      updateSpy,
      insertSpy,
    });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: false } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: "APPLIED" });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ from_status: "APPLYING", to_status: "APPLIED" });
  });

  it("on a Lever submission failure, records ats_submission_error and does not change status", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("?mode=json")) {
        return new Response(JSON.stringify({ id: LEVER_POSTING_ID, text: "Software Intern", state: "published" }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("storage.example")) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      // The actual Lever submission fails.
      return new Response("Missing required field: phone", { status: 422 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const updateSpy = vi.fn();
    const supabase = makeSupabaseMock({ updateSpy });
    const req = { supabase, params: { id: APP_ID }, body: { dry_run: false } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getSubmitHandler(ENABLED_ENV), req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect((res as unknown as { body: { error: string } }).body.error).toBe("ats_submission_failed");
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toEqual({ ats_submission_error: "Missing required field: phone" });
  });
});
