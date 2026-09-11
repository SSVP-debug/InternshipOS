import { h, formatDate, relativeDays, relativeTimeAgo, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  getToday,
  updateOpportunityMatchInbox,
  bulkApply,
  type TodayActionItem,
  type TodayView,
  type DailyQueueItem,
  type OpportunityFeedItem,
} from "../lib/api";
import { classifyDailyQueueState, dailyQueueItemKey, formatMatchMeta } from "../lib/dailyQueue";
import { todayBadgeCount } from "../lib/navBadges";
import { navigate } from "../lib/router";

function actionStub(item: TodayActionItem): HTMLElement {
  const tone = item.days_until_due < 0 ? "stub--urgent" : item.days_until_due <= 1 ? "stub--urgent" : "";
  const reasonLabel =
    item.reason === "deadline_approaching"
      ? "Application deadline"
      : item.reason === "follow_up_overdue"
        ? "Follow-up overdue"
        : "Follow-up due";

  return h("div", { class: `stub ${tone}`.trim() }, [
    h("div", { class: "stub__due" }, [relativeDays(item.days_until_due)]),
    h("div", { class: "stub__body" }, [
      h("div", { class: "stub__title" }, [item.title]),
      h("div", { class: "stub__meta" }, [`${item.company} · ${reasonLabel} · ${formatDate(item.due_date)}`]),
    ]),
    h("div", { class: "stub__actions" }, [
      h(
        "button",
        {
          class: "btn btn--small",
          onClick: () => navigate(`/applications/${item.application_id}`),
        },
        ["Open"],
      ),
    ]),
  ]);
}

export async function renderToday(root: HTMLElement) {
  let main = renderShell(root, "/today");

  main.append(h("div", { class: "page-loading" }, ["Loading your day…"]));

  let view: TodayView;
  try {
    view = await getToday();
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  // Phase B3: local, mutable working copy of the queue so item actions
  // (save/dismiss/priority/apply — all real, existing endpoints, see
  // renderQueueMatchItem below) can update the UI immediately without a
  // full re-fetch, the same pattern pages/opportunityFeed.ts already uses
  // for its own cards. `undefined` (field missing) is preserved as-is —
  // see classifyDailyQueueState's own comment on why that must never be
  // treated the same as an empty array.
  let dailyQueue: DailyQueueItem[] | undefined = view.daily_queue;

  // ── Daily Queue (Phase B3) ─────────────────────────────────────────
  //
  // Renders the additive `daily_queue` field from GET /today (Phase B2)
  // as the page's first, most prominent section — "what should I do
  // next?" The backend (lib/dailyQueue.ts, untouched here) already
  // merged, deduplicated, ordered, and capped (≤5) this list; this
  // function renders it exactly as received; no client-side re-ranking,
  // re-filtering, or pagination. Every action below calls an existing
  // endpoint already used elsewhere in the app (application navigation,
  // opportunity-match inbox toggle, bulk-apply) — no new action type,
  // no auto-apply, no new application state.
  function renderDailyQueueSection(): HTMLElement[] {
    const elements: HTMLElement[] = [];
    elements.push(
      h("div", { class: "page-header" }, [
        h("h2", { class: "section-title", style: "margin:0" }, ["What should I do next?"]),
        h("span", { class: "subtle" }, ["A short list of the most useful things to act on today."]),
      ]),
    );

    const state = classifyDailyQueueState(dailyQueue);

    if (state === "unavailable") {
      // Honest, localized fallback — the rest of Today loaded fine (this
      // whole page only renders that far if the /today request itself
      // succeeded); only this one field is missing/malformed. Never
      // rendered as "You're all caught up" — that would misrepresent an
      // unknown state as a known, good one.
      elements.push(
        h("div", { class: "form-error" }, [
          "Your daily queue couldn't be loaded right now. The rest of Today below is unaffected.",
        ]),
      );
      return elements;
    }

    if (state === "empty") {
      elements.push(
        h("div", { class: "empty" }, [
          "You're all caught up. There are no urgent actions or new opportunities that need your attention right now. ",
          h("a", { href: "#/feed" }, ["Browse your feed"]),
          " or ",
          h("a", { href: "#/applications" }, ["view your applications"]),
          ".",
        ]),
      );
      return elements;
    }

    const card = h("div", { class: "card" }, []);
    (dailyQueue as DailyQueueItem[]).forEach((item, i) => {
      const row = item.reason === "action_required" ? actionStub(item.action) : renderQueueOpportunityItem(item);
      if (i > 0) row.style.borderTop = "1px solid var(--border, #e5e5e5)";
      card.append(row);
    });
    elements.push(card);
    return elements;
  }

  function renderQueueOpportunityItem(
    item: Extract<DailyQueueItem, { reason: "match" }> | Extract<DailyQueueItem, { reason: "opportunity_deadline" }>,
  ): HTMLElement {
    const opportunity = item.opportunity;
    const isUrgentDeadline = item.reason === "opportunity_deadline";

    async function updateInbox(data: { inbox_status?: OpportunityFeedItem["inbox_status"]; is_priority?: boolean }) {
      try {
        const updated = await updateOpportunityMatchInbox(opportunity.opportunity_match_id, data);
        // Saving/dismissing/promoting all mean this match is no longer
        // "untriaged" — the same rule the backend queue membership
        // itself uses (see lib/dailyQueue.ts's isQueueEligibleMatch) — so
        // it leaves the visible queue immediately rather than sitting
        // there showing a stale status until the next full reload.
        if (updated.inbox_status !== "new") {
          dailyQueue = (dailyQueue ?? []).filter((q) => dailyQueueItemKey(q) !== dailyQueueItemKey(item));
        } else {
          opportunity.is_priority = updated.is_priority;
        }
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function toggleSave() {
      await updateInbox({ inbox_status: "saved" });
    }

    async function toggleDismiss() {
      await updateInbox({ inbox_status: "dismissed" });
    }

    async function togglePriority() {
      await updateInbox({ is_priority: !opportunity.is_priority });
    }

    async function apply() {
      try {
        const { results } = await bulkApply([opportunity.opportunity_match_id]);
        const result = results[0];
        if (result.status === "failed") {
          toast(result.error ?? "Could not start an application.", "error");
          return;
        }
        toast(
          result.status === "already_applied" ? "You already started an application for this one." : "Application started.",
        );
        dailyQueue = (dailyQueue ?? []).filter((q) => dailyQueueItemKey(q) !== dailyQueueItemKey(item));
        if (result.application_id) {
          navigate(`/applications/${result.application_id}`);
        } else {
          draw();
        }
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    return h("div", { class: `stub ${isUrgentDeadline ? "stub--urgent" : ""}`.trim() }, [
      // Phase B5: same "days-until" tab used for action_required items
      // (actionStub above), only shown when this item's own inclusion
      // reason IS the deadline — an ordinary "match" item has no
      // due-date concept at all, so it gets no due column.
      isUrgentDeadline
        ? h("div", { class: "stub__due" }, [relativeDays((item as Extract<DailyQueueItem, { reason: "opportunity_deadline" }>).days_until_deadline)])
        : null,
      h("div", { class: "stub__body" }, [
        h("div", { class: "stub__title" }, [
          opportunity.is_priority ? h("span", { class: "star" }, ["★ "]) : "",
          opportunity.title,
          " ",
          isUrgentDeadline
            ? h("span", { class: "pill pill--deadline" }, ["Deadline approaching"])
            : h("span", { class: "pill pill--new" }, ["New match"]),
        ]),
        h("div", { class: "stub__meta" }, [
          `${formatMatchMeta(opportunity)}${
            isUrgentDeadline && opportunity.deadline_date ? ` · Deadline ${formatDate(opportunity.deadline_date)}` : ""
          } · Match ${Math.round(opportunity.match_score)}/100`,
        ]),
      ]),
      h("div", { class: "stub__actions" }, [
        opportunity.application_url
          ? h(
              "a",
              { class: "btn btn--small", href: opportunity.application_url, target: "_blank", rel: "noopener" },
              ["Open listing"],
            )
          : null,
        h("button", { class: "btn btn--small", onClick: togglePriority }, [
          opportunity.is_priority ? "Unflag" : "Flag priority",
        ]),
        h("button", { class: "btn btn--small", onClick: toggleSave }, ["Save"]),
        h("button", { class: "btn btn--small", onClick: toggleDismiss }, ["Dismiss"]),
        h("button", { class: "btn btn--small btn--primary", onClick: apply }, ["Start application"]),
      ]),
    ]);
  }

  function draw() {
    // Small Phase B follow-up ("nav badge polish"): re-mount the shell's
    // nav on every draw so the Today sidebar link's badge stays in sync
    // with the live daily_queue length as items are actioned — see
    // navBadges.ts's own header for why this is Today's own,
    // self-contained count (no cross-page data). renderShell() returns a
    // fresh, already-empty <main>, so there's no separate
    // `main.innerHTML = ""` step needed here (see shell.ts's own comment
    // on why a brand-new <main> is swapped in on every call).
    main = renderShell(root, "/today", { "/today": todayBadgeCount(dailyQueue) });

    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Today"]),
        h("span", { class: "subtle" }, [`Updated ${new Date(view.generated_at).toLocaleTimeString()}`]),
      ]),
    );

    for (const el of renderDailyQueueSection()) main.append(el);

    main.append(
      h("div", { class: "stat-strip" }, [
        stat(view.stats.active_applications, "Active applications"),
        stat(view.stats.overdue_follow_ups_count, "Overdue follow-ups"),
        stat(view.stats.deadlines_next_7_days_count, "Deadlines this week"),
        stat(view.stats.opportunities_needing_triage, "Opportunities to triage"),
      ]),
    );

    // feed_summary: a small, read-only pointer at the candidate's
    // personalized opportunity feed (Phase 2B) — no save/dismiss/priority/
    // apply actions here, only enough to say "you have new matches" and
    // send them to /feed, which remains the one place to act on them.
    // last_ingested_at is a trust signal for the daily automation
    // (.github/workflows/daily-pipeline.yml) — "is the catalog actually
    // being kept fresh," independent of whether it's found this candidate
    // a match yet.
    main.append(
      h("div", { class: "page-header" }, [
        h("h2", { class: "section-title", style: "margin:0" }, ["New matches"]),
        h("span", { class: "subtle" }, [
          view.feed_summary.last_ingested_at === null
            ? "Catalog not yet refreshed"
            : `Catalog refreshed ${relativeTimeAgo(view.feed_summary.last_ingested_at)}`,
        ]),
      ]),
    );
    if (view.feed_summary.top_matches.length === 0) {
      main.append(
        h("div", { class: "empty" }, [
          view.feed_summary.new_matches_count > 0
            ? "You have new matches waiting. "
            : "No new matches right now. ",
          h("a", { href: "#/feed" }, ["Open your feed"]),
          ".",
        ]),
      );
    } else {
      const card = h("div", { class: "card" }, []);
      card.append(
        h("div", { class: "list-row", style: "border-top:none" }, [
          h("div", { class: "list-row__main" }, [
            h("div", { class: "list-row__meta" }, [
              `${view.feed_summary.new_matches_count} new match${view.feed_summary.new_matches_count === 1 ? "" : "es"} to review`,
            ]),
          ]),
          h("button", { class: "btn btn--small btn--primary", onClick: () => navigate("/feed") }, ["Open feed"]),
        ]),
      );
      view.feed_summary.top_matches.forEach((m) => {
        card.append(
          h("div", { class: "list-row" }, [
            h("div", { class: "list-row__main" }, [
              h("div", { class: "list-row__title" }, [m.title]),
              h("div", { class: "list-row__meta" }, [`${m.company} · Match ${Math.round(m.match_score)}`]),
            ]),
            h("button", { class: "btn btn--small", onClick: () => navigate("/feed") }, ["View"]),
          ]),
        );
      });
      main.append(card);
    }

    main.append(h("h2", { class: "section-title" }, ["Needs your attention"]));
    if (view.action_required.length === 0) {
      main.append(h("div", { class: "empty" }, ["Nothing urgent today — nice work staying on top of it."]));
    } else {
      for (const item of view.action_required) main.append(actionStub(item));
    }

    main.append(h("h2", { class: "section-title" }, ["Deadlines approaching"]));
    if (view.deadlines_approaching.length === 0) {
      main.append(h("div", { class: "empty" }, ["No deadlines in the next two weeks."]));
    } else {
      for (const item of view.deadlines_approaching) main.append(actionStub(item));
    }

    main.append(h("h2", { class: "section-title" }, ["Saved opportunities"]));
    if (view.saved_opportunities.length === 0) {
      main.append(
        h("div", { class: "empty" }, [
          "Nothing saved yet. ",
          h("a", { href: "#/opportunities" }, ["Add one to your inbox"]),
          ".",
        ]),
      );
    } else {
      const card = h("div", { class: "card" }, []);
      view.saved_opportunities.forEach((o, i) => {
        card.append(
          h("div", { class: "list-row", style: i === 0 ? "border-top:none" : undefined }, [
            h("div", { class: "list-row__main" }, [
              h("div", { class: "list-row__title" }, [o.is_priority ? h("span", { class: "star" }, ["★ "]) : "", o.title]),
              h("div", { class: "list-row__meta" }, [
                `${o.company}${o.deadline_date ? ` · Deadline ${formatDate(o.deadline_date)}` : ""}`,
              ]),
            ]),
            h(
              "button",
              {
                class: "btn btn--small btn--primary",
                onClick: () => navigate(`/opportunities`),
              },
              ["Start application"],
            ),
          ]),
        );
      });
      main.append(card);
    }

    main.append(h("h2", { class: "section-title" }, ["Recently applied"]));
    if (view.recently_applied.length === 0) {
      main.append(h("div", { class: "empty" }, ["Nothing applied to in the last 7 days."]));
    } else {
      const card = h("div", { class: "card" }, []);
      view.recently_applied.forEach((a) => {
        card.append(
          h("div", { class: "list-row" }, [
            h("div", { class: "list-row__main" }, [
              h("div", { class: "list-row__title" }, [a.title]),
              h("div", { class: "list-row__meta" }, [`${a.company} · Applied ${formatDate(a.applied_at)}`]),
            ]),
            h(
              "button",
              { class: "btn btn--small", onClick: () => navigate(`/applications/${a.application_id}`) },
              ["Open"],
            ),
          ]),
        );
      });
      main.append(card);
    }

    main.append(h("h2", { class: "section-title" }, ["Pipeline"]));
    const pipelineCard = h("div", { class: "card" }, []);
    const order = ["SAVED", "APPLYING", "APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"];
    const pipelineRow = h(
      "div",
      { style: "display:flex;gap:18px;flex-wrap:wrap" },
      order.map((status) =>
        h("div", { style: "text-align:center" }, [
          h("div", { style: "font-family:var(--font-display);font-size:22px;font-weight:700" }, [
            String(view.pipeline_summary[status] ?? 0),
          ]),
          h("div", { class: "subtle" }, [status]),
        ]),
      ),
    );
    pipelineCard.append(pipelineRow);
    main.append(pipelineCard);
  }

  draw();
}

function stat(value: number, label: string): HTMLElement {
  return h("div", { class: "stat" }, [h("div", { class: "stat__value" }, [String(value)]), h("div", { class: "stat__label" }, [label])]);
}
