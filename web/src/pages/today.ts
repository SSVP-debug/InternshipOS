import { h, formatDate, relativeDays, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import { getToday, type TodayActionItem, type TodayView } from "../lib/api";
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
  const main = renderShell(root, "/today");

  main.append(h("div", { class: "page-loading" }, ["Loading your day…"]));

  let view: TodayView;
  try {
    view = await getToday();
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }
  main.innerHTML = "";

  main.append(
    h("div", { class: "page-header" }, [
      h("h1", {}, ["Today"]),
      h("span", { class: "subtle" }, [`Updated ${new Date(view.generated_at).toLocaleTimeString()}`]),
    ]),
  );

  main.append(
    h("div", { class: "stat-strip" }, [
      stat(view.stats.active_applications, "Active applications"),
      stat(view.stats.overdue_follow_ups_count, "Overdue follow-ups"),
      stat(view.stats.deadlines_next_7_days_count, "Deadlines this week"),
      stat(view.stats.opportunities_needing_triage, "Opportunities to triage"),
    ]),
  );

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

function stat(value: number, label: string): HTMLElement {
  return h("div", { class: "stat" }, [h("div", { class: "stat__value" }, [String(value)]), h("div", { class: "stat__label" }, [label])]);
}
