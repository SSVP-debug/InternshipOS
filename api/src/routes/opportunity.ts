// opportunity.ts
// GET    /opportunities              — list the caller's own opportunities
//                                       (excludes dismissed by default; see
//                                       ?include_dismissed=true)
// GET    /opportunities/:id          — get one of the caller's own opportunities
// POST   /opportunities              — add an opportunity (manual/import-based
//                                       discovery — see 0017_opportunity.sql)
// PUT    /opportunities/:id          — full update of the opportunity's own fields
// PATCH  /opportunities/:id/inbox    — the ONLY way to change inbox_status
//                                       (save/dismiss) or is_priority — the
//                                       Opportunity Inbox actions from the
//                                       task brief §4.C
// DELETE /opportunities/:id          — remove an opportunity (cascades to any
//                                       application on it — see 0018's ON
//                                       DELETE CASCADE)
//
// Same ownership pattern as every other route: every query runs through
// req.supabase (the caller's own JWT), so RLS — not this code — prevents
// reading/writing another candidate's opportunities.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { OpportunityRequestSchema, OpportunityInboxUpdateSchema, UuidParamSchema } from "../lib/schemas.js";

const OPPORTUNITY_COLUMNS =
  "id, title, company, description, location, work_mode, employment_type, skills, " +
  "application_url, source, deadline_date, posted_date, inbox_status, is_priority, " +
  "created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function opportunityRouter(): Router {
  const router = Router();

  router.get("/opportunities", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const includeDismissed = req.query.include_dismissed === "true";
    const inboxStatusFilter =
      typeof req.query.inbox_status === "string" ? req.query.inbox_status : undefined;

    let query = supabase
      .from("opportunity")
      .select(OPPORTUNITY_COLUMNS)
      .order("is_priority", { ascending: false })
      .order("deadline_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (inboxStatusFilter) {
      query = query.eq("inbox_status", inboxStatusFilter);
    } else if (!includeDismissed) {
      query = query.neq("inbox_status", "dismissed");
    }

    const { data, error } = await query;
    if (error) {
      return res.status(400).json({ error: "opportunity_fetch_failed", message: error.message });
    }
    return res.status(200).json({ opportunities: data });
  });

  router.get("/opportunities/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("opportunity")
      .select(OPPORTUNITY_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "opportunity_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "opportunity_not_found" });
    }
    return res.status(200).json({ opportunity: data });
  });

  router.post("/opportunities", async (req: AuthedRequest, res) => {
    const parsed = OpportunityRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("opportunity")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(OPPORTUNITY_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "opportunity_create_failed", message: error.message });
    }
    return res.status(201).json({ opportunity: data });
  });

  router.put("/opportunities/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = OpportunityRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("opportunity")
      .update(parsed.data) // never includes inbox_status/is_priority — see schema comment
      .eq("id", idParsed.data)
      .select(OPPORTUNITY_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "opportunity_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "opportunity_not_found" });
    }
    return res.status(200).json({ opportunity: data });
  });

  router.patch("/opportunities/:id/inbox", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = OpportunityInboxUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("opportunity")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(OPPORTUNITY_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "opportunity_inbox_update_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "opportunity_not_found" });
    }
    return res.status(200).json({ opportunity: data });
  });

  router.delete("/opportunities/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("opportunity")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "opportunity_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "opportunity_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
