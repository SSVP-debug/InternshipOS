// today.ts
// GET /today — the dashboard from task brief §4.A: "What should I do
// today?" A thin route: fetches the caller's own applications and
// opportunities (through req.supabase, so RLS scopes it to them) and
// hands the raw rows to buildTodayView() (lib/todayView.ts), which is
// pure and unit-tested on its own.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { buildTodayView, type ApplicationRow, type OpportunityRow } from "../lib/todayView.js";

export function todayRouter(): Router {
  const router = Router();

  router.get("/today", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;

    const { data: candidate, error: candidateError } = await supabase.from("candidate").select("id").single();
    if (candidateError || !candidate) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const [applicationsResult, opportunitiesResult] = await Promise.all([
      supabase
        .from("application")
        .select("id, opportunity_id, status, applied_at, deadline_override, next_action_date, next_action_note, updated_at"),
      supabase
        .from("opportunity")
        .select("id, title, company, application_url, deadline_date, inbox_status, is_priority"),
    ]);

    if (applicationsResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: applicationsResult.error.message });
    }
    if (opportunitiesResult.error) {
      return res.status(400).json({ error: "today_fetch_failed", message: opportunitiesResult.error.message });
    }

    const view = buildTodayView({
      applications: (applicationsResult.data ?? []) as ApplicationRow[],
      opportunities: (opportunitiesResult.data ?? []) as OpportunityRow[],
      now: new Date(),
    });

    return res.status(200).json(view);
  });

  return router;
}
