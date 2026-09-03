import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../src/middleware/auth.js";
import { resumeRouter } from "../src/routes/resume.js";

const CANDIDATE_ID = "00000000-0000-0000-0000-000000000000";
const RESUME_ID = "11111111-1111-1111-1111-111111111111";
const SKILL_ID = "22222222-2222-2222-2222-222222222222";

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: (req: AuthedRequest, res: Response, next: (err?: unknown) => void) => unknown }[];
  };
}

function getHandlers(method: "get" | "post" | "put" | "delete", path: string) {
  const router = resumeRouter() as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) throw new Error(`no route registered for ${method.toUpperCase()} ${path}`);
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
  res.send = vi.fn(() => res) as unknown as Response["send"];
  return res;
}

function queryResult(data: unknown, error: { message: string; code?: string } | null = null) {
  const result = { data, error };
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.eq = self;
  builder.in = self;
  builder.order = self;
  builder.update = self;
  builder.delete = self;
  builder.single = async () => result;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

function makeSupabaseMock(opts: {
  candidate?: { id: string } | null;
  resumeList?: { data: unknown; error: { message: string } | null };
  resumeSingle?: { data: unknown; error: { message: string } | null };
  resumeInsert?: { data: unknown; error: { message: string; code?: string } | null };
  resumeUpdate?: { data: unknown; error: { message: string } | null };
  resumeSkillLinks?: { data: unknown; error: { message: string } | null };
  skillRows?: { data: unknown; error: { message: string } | null };
  ownedSkillLookup?: { data: unknown; error: { message: string } | null };
  resumeSkillInsert?: { error: { message: string; code?: string } | null };
  resumeSkillDelete?: { data: unknown; error: { message: string } | null };
} = {}) {
  const {
    candidate = { id: CANDIDATE_ID },
    resumeList = { data: [], error: null },
    resumeSingle = { data: { id: RESUME_ID, label: "Software Development", target_role_category: null, evidence_source_id: null, is_active: true, created_at: "t", updated_at: "t" }, error: null },
    resumeInsert = { data: { id: RESUME_ID, label: "Software Development", target_role_category: null, evidence_source_id: null, is_active: true, created_at: "t", updated_at: "t" }, error: null },
    resumeUpdate = resumeSingle,
    resumeSkillLinks = { data: [], error: null },
    skillRows = { data: [], error: null },
    ownedSkillLookup = { data: { id: SKILL_ID, name: "Python", category: "language" }, error: null },
    resumeSkillInsert = { error: null },
    resumeSkillDelete = { data: { id: "link-1" }, error: null },
  } = opts;

  return {
    from(table: string) {
      if (table === "candidate") {
        return { select: () => ({ single: async () => ({ data: candidate, error: candidate ? null : { message: "not found" } }) }) };
      }
      if (table === "resume") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => resumeSingle }),
            order: () => queryResult(resumeList.data, resumeList.error),
          }),
          insert: () => ({ select: () => ({ single: async () => resumeInsert }) }),
          update: () => ({
            eq: () => ({ select: () => ({ maybeSingle: async () => resumeUpdate }) }),
          }),
        };
      }
      if (table === "resume_skill") {
        return {
          select: () => ({ in: () => queryResult(resumeSkillLinks.data, resumeSkillLinks.error) }),
          insert: async () => resumeSkillInsert,
          delete: () => ({
            eq: () => ({
              eq: () => ({ select: () => ({ maybeSingle: async () => resumeSkillDelete }) }),
            }),
          }),
        };
      }
      if (table === "skill") {
        return {
          select: () => ({
            in: () => queryResult(skillRows.data, skillRows.error),
            eq: () => ({ maybeSingle: async () => ownedSkillLookup }),
          }),
        };
      }
      return queryResult([], null);
    },
  };
}

describe("GET /resumes", () => {
  it("returns each resume enriched with its attached skills", async () => {
    const supabase = makeSupabaseMock({
      resumeList: { data: [{ id: RESUME_ID, label: "Software Development", target_role_category: null, evidence_source_id: null, is_active: true, created_at: "t", updated_at: "t" }], error: null },
      resumeSkillLinks: { data: [{ resume_id: RESUME_ID, skill_id: SKILL_ID }], error: null },
      skillRows: { data: [{ id: SKILL_ID, name: "Python", category: "language" }], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/resumes"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { resumes: Array<{ skills: Array<{ id: string }> }> };
    expect(body.resumes[0].skills).toEqual([{ id: SKILL_ID, name: "Python", category: "language" }]);
  });

  it("returns an empty skills array for a resume with none, no crash", async () => {
    const supabase = makeSupabaseMock({
      resumeList: { data: [{ id: RESUME_ID, label: "AI/ML", target_role_category: null, evidence_source_id: null, is_active: true, created_at: "t", updated_at: "t" }], error: null },
    });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/resumes"), req, res);

    const body = res.body as { resumes: Array<{ skills: unknown[] }> };
    expect(body.resumes[0].skills).toEqual([]);
  });

  it("returns 400 on a resume fetch error", async () => {
    const supabase = makeSupabaseMock({ resumeList: { data: null, error: { message: "timeout" } } });
    const req = { supabase } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/resumes"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("GET /resumes/:id", () => {
  it("returns 404 when the resume doesn't exist or isn't owned", async () => {
    const supabase = makeSupabaseMock({ resumeSingle: { data: null, error: null } });
    const req = { supabase, params: { id: RESUME_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/resumes/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("rejects a malformed id with 400 before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: "not-a-uuid" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("get", "/resumes/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("POST /resumes", () => {
  it("creates a resume with an empty skills array", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, body: { label: "Software Development" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.body as { resume: { skills: unknown[] } };
    expect(body.resume.skills).toEqual([]);
  });

  it("rejects an empty label with 400 before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, body: { label: "" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when the caller has no candidate row", async () => {
    const supabase = makeSupabaseMock({ candidate: null });
    const req = { supabase, body: { label: "x" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("PUT /resumes/:id — archive/unarchive is is_active", () => {
  it("archives a resume via is_active: false", async () => {
    const supabase = makeSupabaseMock({
      resumeUpdate: { data: { id: RESUME_ID, label: "x", target_role_category: null, evidence_source_id: null, is_active: false, created_at: "t", updated_at: "t" }, error: null },
    });
    const req = { supabase, params: { id: RESUME_ID }, body: { is_active: false } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/resumes/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.body as { resume: { is_active: boolean } };
    expect(body.resume.is_active).toBe(false);
  });

  it("returns 404 for a cross-candidate update (RLS no-op surfaces as not found)", async () => {
    const supabase = makeSupabaseMock({ resumeUpdate: { data: null, error: null } });
    const req = { supabase, params: { id: RESUME_ID }, body: { label: "Hacked" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("put", "/resumes/:id"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("POST /resumes/:id/skills", () => {
  it("attaches an owned skill to an owned resume", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: RESUME_ID }, body: { skill_id: SKILL_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes/:id/skills"), req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns 404 resume_not_found when the resume isn't owned", async () => {
    const supabase = makeSupabaseMock({ resumeSingle: { data: null, error: null } });
    const req = { supabase, params: { id: RESUME_ID }, body: { skill_id: SKILL_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes/:id/skills"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.body as { error: string }).error).toBe("resume_not_found");
  });

  it("returns 404 skill_not_found when the skill isn't owned", async () => {
    const supabase = makeSupabaseMock({ ownedSkillLookup: { data: null, error: null } });
    const req = { supabase, params: { id: RESUME_ID }, body: { skill_id: SKILL_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes/:id/skills"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.body as { error: string }).error).toBe("skill_not_found");
  });

  it("returns 409 skill_already_on_resume on a unique_violation", async () => {
    const supabase = makeSupabaseMock({ resumeSkillInsert: { error: { message: "duplicate key", code: "23505" } } });
    const req = { supabase, params: { id: RESUME_ID }, body: { skill_id: SKILL_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes/:id/skills"), req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res.body as { error: string }).error).toBe("skill_already_on_resume");
  });

  it("rejects a malformed skill_id with 400 before touching the database", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: RESUME_ID }, body: { skill_id: "not-a-uuid" } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("post", "/resumes/:id/skills"), req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("DELETE /resumes/:id/skills/:skillId", () => {
  it("detaches a skill from a resume", async () => {
    const supabase = makeSupabaseMock();
    const req = { supabase, params: { id: RESUME_ID, skillId: SKILL_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/resumes/:id/skills/:skillId"), req, res);

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 404 when the link doesn't exist", async () => {
    const supabase = makeSupabaseMock({ resumeSkillDelete: { data: null, error: null } });
    const req = { supabase, params: { id: RESUME_ID, skillId: SKILL_ID } } as unknown as AuthedRequest;
    const res = makeRes();

    await runRoute(getHandlers("delete", "/resumes/:id/skills/:skillId"), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
