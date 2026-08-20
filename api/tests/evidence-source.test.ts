import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { evidenceSourceRouter } from "../src/routes/evidence-source.js";

// Same router-introspection harness as claim.test.ts / truth-center.test.ts.

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post" | "put" | "delete", path: string) {
  const router = evidenceSourceRouter() as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

// requireConsent (used by POST /evidence-sources/upload-url) calls next()
// without awaiting it — normal Express middleware style, since Express
// itself drives the chain rather than the middleware awaiting its own
// downstream. A harness that just does `await handlers[0](...)` races: it
// resolves as soon as the middleware's own function body returns, which
// happens right after it fires next() but before the actual route handler
// (and its async Supabase/Storage calls) has finished. This version
// resolves only once whichever handler actually terminates the response
// (never calls next()) has itself finished — regardless of how many
// unawaited next() hops it took to get there.
async function runRoute(
  handlers: ((req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown)[],
  req: AuthedRequest,
  res: Response
) {
  await new Promise<void>((resolve, reject) => {
    const invoke = async (i: number) => {
      if (i >= handlers.length) return resolve();
      let nextCalled = false;
      const next = async (err?: unknown) => {
        nextCalled = true;
        if (err) return reject(err);
        await invoke(i + 1);
      };
      try {
        await handlers[i](req, res, next);
        if (!nextCalled) resolve(); // this handler terminated the response itself
      } catch (e) {
        reject(e);
      }
    };
    invoke(0).catch(reject);
  });
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
  res.send = vi.fn(() => res) as unknown as Response["send"];
  return res;
}

const CAND_ID = "cand-1";

interface MockOpts {
  candidate?: { id: string } | null;
  hasConsent?: boolean; // document_upload_storage consent present?
  createSignedUploadUrlResult?: { data: unknown; error: { message: string } | null };
  createSignedUrlResult?: { data: unknown; error: { message: string } | null };
  listResult?: { data: unknown[]; error: { message: string } | null };
  removeMock?: ReturnType<typeof vi.fn>;
  evidenceSourceRow?: Record<string, unknown> | null;
  insertResult?: { data: unknown; error: { message: string } | null };
  updateResult?: { data: unknown; error: { message: string } | null };
  deleteResult?: { data: unknown; error: { message: string } | null };
}

function makeSupabaseMock(opts: MockOpts) {
  const {
    candidate = { id: CAND_ID },
    hasConsent = true,
    createSignedUploadUrlResult,
    createSignedUrlResult,
    listResult,
    removeMock = vi.fn(async () => ({ error: null })),
    evidenceSourceRow,
    insertResult,
    updateResult,
    deleteResult,
  } = opts;

  return {
    from(table: string) {
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      if (table === "consent_record") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({ data: hasConsent ? { id: "consent-1" } : null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "evidence_source") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: evidenceSourceRow ?? null, error: null }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => insertResult ?? { data: null, error: { message: "unexpected insert" } },
            }),
          }),
          update: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => updateResult ?? { data: null, error: { message: "unexpected update" } },
              }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => deleteResult ?? { data: null, error: { message: "unexpected delete" } },
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in mock: ${table}`);
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => createSignedUploadUrlResult ?? { data: null, error: { message: "unexpected call" } },
        createSignedUrl: async () => createSignedUrlResult ?? { data: null, error: { message: "unexpected call" } },
        list: async () => listResult ?? { data: [], error: null },
        remove: removeMock,
      }),
    },
  };
}

describe("POST /evidence-sources/upload-url", () => {
  it("returns 403 consent_required when document_upload_storage consent is missing", async () => {
    const supabase = makeSupabaseMock({ hasConsent: false });
    const req = { supabase, body: { filename: "resume.pdf" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources/upload-url"), req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ error: "consent_required", consent_type: "document_upload_storage" });
  });

  it("returns a signed upload URL and a candidate-prefixed path when consent is present", async () => {
    const supabase = makeSupabaseMock({
      hasConsent: true,
      createSignedUploadUrlResult: {
        data: { path: `${CAND_ID}/abc-resume.pdf`, signedUrl: "https://storage.example/sign/abc", token: "tok-123" },
        error: null,
      },
    });
    const req = { supabase, body: { filename: "resume.pdf" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources/upload-url"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toMatchObject({
      path: `${CAND_ID}/abc-resume.pdf`,
      signed_url: "https://storage.example/sign/abc",
      token: "tok-123",
    });
  });

  it("returns 400 invalid_request when filename is missing", async () => {
    const supabase = makeSupabaseMock({ hasConsent: true });
    const req = { supabase, body: {} } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources/upload-url"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "invalid_request" });
  });
});

describe("GET /evidence-sources/:id/download-url", () => {
  const VALID_ID = "11111111-1111-4111-8111-111111111111";

  it("returns a signed download URL for a document_upload evidence source", async () => {
    const supabase = makeSupabaseMock({
      evidenceSourceRow: { source_type: "document_upload", file_ref: `${CAND_ID}/resume.pdf` },
      createSignedUrlResult: { data: { signedUrl: "https://storage.example/sign/download" }, error: null },
    });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/evidence-sources/:id/download-url"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ download_url: "https://storage.example/sign/download", expires_in: 300 });
  });

  it("returns 400 not_a_document_upload for a github_repository evidence source", async () => {
    const supabase = makeSupabaseMock({
      evidenceSourceRow: { source_type: "github_repository", file_ref: null },
    });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/evidence-sources/:id/download-url"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "not_a_document_upload" });
  });

  it("returns 404 when the evidence source doesn't exist (or isn't the caller's)", async () => {
    const supabase = makeSupabaseMock({ evidenceSourceRow: null });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/evidence-sources/:id/download-url"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("POST /evidence-sources — file_ref validation (Gate 1a)", () => {
  it("returns 400 file_ref_not_found when file_ref doesn't exist in Storage", async () => {
    const supabase = makeSupabaseMock({ listResult: { data: [], error: null } });
    const req = {
      supabase,
      body: { source_type: "document_upload", title: "Resume.pdf", file_ref: `${CAND_ID}/resume.pdf` },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "file_ref_not_found" });
  });

  it("returns 400 file_ref_not_found when file_ref isn't under the caller's own candidate_id prefix", async () => {
    const supabase = makeSupabaseMock({});
    const req = {
      supabase,
      body: { source_type: "document_upload", title: "Resume.pdf", file_ref: "someone-elses-cand-id/resume.pdf" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "file_ref_not_found" });
  });

  it("creates the row when file_ref exists under the caller's own prefix", async () => {
    const created = { id: "ev-1", source_type: "document_upload", file_ref: `${CAND_ID}/resume.pdf` };
    const supabase = makeSupabaseMock({
      listResult: { data: [{ name: "resume.pdf" }], error: null },
      insertResult: { data: created, error: null },
    });
    const req = {
      supabase,
      body: { source_type: "document_upload", title: "Resume.pdf", file_ref: `${CAND_ID}/resume.pdf` },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toMatchObject({ evidence_source: created });
  });

  it("does not run the file_ref check at all for github_repository", async () => {
    const created = { id: "ev-2", source_type: "github_repository" };
    const supabase = makeSupabaseMock({ insertResult: { data: created, error: null } });
    const req = {
      supabase,
      body: { source_type: "github_repository", title: "Repo", external_url: "https://github.com/example/repo" },
    } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/evidence-sources"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("DELETE /evidence-sources/:id — Storage purge (Gate 1a)", () => {
  const VALID_ID = "11111111-1111-4111-8111-111111111111";

  it("purges the Storage object for a document_upload evidence source", async () => {
    const removeMock = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabaseMock({
      deleteResult: { data: { id: VALID_ID, source_type: "document_upload", file_ref: `${CAND_ID}/resume.pdf` }, error: null },
      removeMock,
    });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/evidence-sources/:id"), req, res);

    expect(removeMock).toHaveBeenCalledWith([`${CAND_ID}/resume.pdf`]);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("still returns 204 when the Storage purge fails — best-effort, not blocking", async () => {
    const removeMock = vi.fn(async () => ({ error: { message: "Storage unavailable" } }));
    const supabase = makeSupabaseMock({
      deleteResult: { data: { id: VALID_ID, source_type: "document_upload", file_ref: `${CAND_ID}/resume.pdf` }, error: null },
      removeMock,
    });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/evidence-sources/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("does not call Storage remove for a github_repository evidence source", async () => {
    const removeMock = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabaseMock({
      deleteResult: { data: { id: VALID_ID, source_type: "github_repository", file_ref: null }, error: null },
      removeMock,
    });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/evidence-sources/:id"), req, res);

    expect(removeMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 404 without attempting Storage removal when the evidence source doesn't exist", async () => {
    const removeMock = vi.fn(async () => ({ error: null }));
    const supabase = makeSupabaseMock({ deleteResult: { data: null, error: null }, removeMock });
    const req = { supabase, params: { id: VALID_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/evidence-sources/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(removeMock).not.toHaveBeenCalled();
  });
});
