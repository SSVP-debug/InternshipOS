import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { truthCenterRouter } from "../src/routes/truth-center.js";

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get", path: string) {
  const router = truthCenterRouter() as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(
  handlers: ((req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown)[],
  req: AuthedRequest,
  res: Response
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

function queryResult(data: unknown, error: { message: string } | null = null) {
  return Promise.resolve({ data, error });
}

interface Claim {
  id: string;
  subject_entity_type: string;
  subject_entity_id: string;
  claim_text: string;
  status: string;
  evidence_source_id: string | null;
  last_reviewed_at: string | null;
  created_at: string;
}

function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  claims?: Claim[];
  claimsError?: { message: string } | null;
  evidenceRows?: Record<string, unknown>[];
  evidenceError?: { message: string } | null;
  entityTables?: Record<string, Record<string, unknown>[]>;
}) {
  const {
    candidate = { id: "cand-1" },
    claims = [],
    claimsError = null,
    evidenceRows = [],
    evidenceError = null,
    entityTables = {},
  } = opts;

  return {
    from(table: string) {
      if (table === "candidate") {
        return {
          select: () => ({
            single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }),
          }),
        };
      }
      if (table === "claim") {
        return { select: () => ({ order: () => queryResult(claims, claimsError) }) };
      }
      if (table === "evidence_source") {
        return { select: () => ({ in: () => queryResult(evidenceRows, evidenceError) }) };
      }
      const rows = entityTables[table] ?? [];
      return { select: () => ({ in: () => queryResult(rows, null) }) };
    },
  };
}

const NOW = "2026-08-17T00:00:00.000Z";

describe("GET /truth-center", () => {
  it("returns 404 when the caller has no candidate row", async () => {
    const supabase = makeSupabaseMock({ candidate: null });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns empty groups and a zero review count when the candidate has no claims", async () => {
    const supabase = makeSupabaseMock({ claims: [] });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ claims_needing_review_count: 0, groups: {} });
  });

  it("returns 400 when the claim query errors", async () => {
    const supabase = makeSupabaseMock({ claimsError: { message: "connection reset" } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("computes tier_1_verified only for owner_verified github_repository evidence", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "project",
          subject_entity_id: "proj-1",
          claim_text: "Built InternshipOS.",
          status: "CONFIRMED",
          evidence_source_id: "ev-1",
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      evidenceRows: [
        {
          id: "ev-1",
          source_type: "github_repository",
          title: "InternshipOS",
          file_ref: null,
          external_url: "https://github.com/example/internshipos",
          owner_verified: true,
        },
      ],
      entityTables: { project: [{ id: "proj-1", title: "InternshipOS" }] },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as { groups: Record<string, Array<Record<string, unknown>>> };
    const claim = body.groups.project[0];
    expect(claim.trust_tier).toBe("tier_1_verified");
    expect(claim.trust_tier_label).toBe("Verified");
    expect(claim.evidence_link).toBe("https://github.com/example/internshipos");
    expect(claim.subject_entity_name).toBe("InternshipOS");
    expect(claim.subject_entity_label).toBe("Project: InternshipOS");
  });

  it("treats an unverified github_repository as tier_2_document, not tier_1 or tier_3", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "project",
          subject_entity_id: "proj-1",
          claim_text: "Built InternshipOS.",
          status: "DRAFT",
          evidence_source_id: "ev-1",
          last_reviewed_at: null,
          created_at: NOW,
        },
      ],
      evidenceRows: [
        {
          id: "ev-1",
          source_type: "github_repository",
          title: "InternshipOS",
          file_ref: null,
          external_url: "https://github.com/example/internshipos",
          owner_verified: false,
        },
      ],
      entityTables: { project: [{ id: "proj-1", title: "InternshipOS" }] },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as {
      groups: Record<string, Array<Record<string, unknown>>>;
      claims_needing_review_count: number;
    };
    expect(body.groups.project[0].trust_tier).toBe("tier_2_document");
    expect(body.claims_needing_review_count).toBe(1); // status DRAFT
  });

  it("computes tier_2_document for document_upload evidence", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "certification",
          subject_entity_id: "cert-1",
          claim_text: "AWS certified.",
          status: "CONFIRMED",
          evidence_source_id: "ev-1",
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      evidenceRows: [
        {
          id: "ev-1",
          source_type: "document_upload",
          title: "AWS-cert.pdf",
          file_ref: "uploads/cand-1/aws-cert.pdf",
          external_url: null,
          owner_verified: false,
        },
      ],
      entityTables: { certification: [{ id: "cert-1", name: "AWS Certified" }] },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as { groups: Record<string, Array<Record<string, unknown>>> };
    const claim = body.groups.certification[0];
    expect(claim.trust_tier).toBe("tier_2_document");
    // Gate 1a: no more raw file_ref exposure — null here, and the client
    // uses evidence_source_id against GET /evidence-sources/:id/download-url
    // to get a real, short-lived link on demand.
    expect(claim.evidence_link).toBeNull();
    expect(claim.evidence_source_id).toBe("ev-1");
  });

  it("computes tier_3_self_attested when a claim has no evidence_source_id", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "skill",
          subject_entity_id: "skill-1",
          claim_text: "Proficient in TypeScript.",
          status: "CONFIRMED",
          evidence_source_id: null,
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      entityTables: { skill: [{ id: "skill-1", name: "TypeScript" }] },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as { groups: Record<string, Array<Record<string, unknown>>> };
    const claim = body.groups.skill[0];
    expect(claim.trust_tier).toBe("tier_3_self_attested");
    expect(claim.evidence_link).toBeNull();
    expect(claim.evidence_summary).toBe("Self-reported, no supporting evidence.");
  });

  it("handles the work_authorization singleton type by its candidate_id, with a static display name", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "work_authorization",
          subject_entity_id: "cand-1",
          claim_text: "Authorized to work in the US without sponsorship.",
          status: "CONFIRMED",
          evidence_source_id: null,
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      entityTables: { work_authorization: [{ candidate_id: "cand-1", status: "us_citizen" }] },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as { groups: Record<string, Array<Record<string, unknown>>> };
    const claim = body.groups.work_authorization[0];
    expect(claim.subject_entity_name).toBe("Work Authorization");
    expect(claim.subject_entity_label).toBe("Work Authorization: Work Authorization");
  });

  it("degrades gracefully with a null name when the referenced entity no longer exists (orphaned claim)", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "project",
          subject_entity_id: "deleted-project-id",
          claim_text: "Built a project that was later deleted.",
          status: "SUPERSEDED",
          evidence_source_id: null,
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      entityTables: { project: [] }, // the referenced project id doesn't come back
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    expect(res.status).toHaveBeenCalledWith(200); // does not error the whole response
    const body = res.body as { groups: Record<string, Array<Record<string, unknown>>> };
    const claim = body.groups.project[0];
    expect(claim.subject_entity_name).toBeNull();
    expect(claim.subject_entity_label).toBe("Project"); // falls back to just the type label
  });

  it("always reports used_in_applications_count as 0 (no Application table exists yet, per §8)", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "skill",
          subject_entity_id: "skill-1",
          claim_text: "Proficient in TypeScript.",
          status: "CONFIRMED",
          evidence_source_id: null,
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      entityTables: { skill: [{ id: "skill-1", name: "TypeScript" }] },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as { groups: Record<string, Array<Record<string, unknown>>> };
    expect(body.groups.skill[0].used_in_applications_count).toBe(0);
  });

  it("groups claims by subject_entity_type and counts only DRAFT claims as needing review", async () => {
    const supabase = makeSupabaseMock({
      claims: [
        {
          id: "claim-1",
          subject_entity_type: "skill",
          subject_entity_id: "skill-1",
          claim_text: "Proficient in TypeScript.",
          status: "DRAFT",
          evidence_source_id: null,
          last_reviewed_at: null,
          created_at: NOW,
        },
        {
          id: "claim-2",
          subject_entity_type: "skill",
          subject_entity_id: "skill-2",
          claim_text: "Proficient in Python.",
          status: "CONFIRMED",
          evidence_source_id: null,
          last_reviewed_at: NOW,
          created_at: NOW,
        },
        {
          id: "claim-3",
          subject_entity_type: "project",
          subject_entity_id: "proj-1",
          claim_text: "Built InternshipOS.",
          status: "REVOKED",
          evidence_source_id: null,
          last_reviewed_at: NOW,
          created_at: NOW,
        },
      ],
      entityTables: {
        skill: [
          { id: "skill-1", name: "TypeScript" },
          { id: "skill-2", name: "Python" },
        ],
        project: [{ id: "proj-1", title: "InternshipOS" }],
      },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/truth-center"), req, res);

    const body = res.body as { groups: Record<string, unknown[]>; claims_needing_review_count: number };
    expect(body.groups.skill).toHaveLength(2);
    expect(body.groups.project).toHaveLength(1);
    expect(body.claims_needing_review_count).toBe(1); // only claim-1 is DRAFT; REVOKED still appears in groups
  });
});
