// opportunityFeed.ts — the candidate's matched-opportunities feed.
//
// GATE R7 CHANGES:
//   1. Resume tabs ("All" + one per active resume, from resume_groups) —
//      switching tabs re-fetches getOpportunityFeed(resumeId), which
//      swaps `items` to that resume's scoped matches (Gate R3's own
//      contract — see api.ts's getOpportunityFeed comment).
//   2. Apply now calls bulkApply() (Gate R5/R6) instead of the old
//      three-request manual dance (createOpportunity + createApplication
//      + updateOpportunityMatchInbox) this file used to do inline. Same
//      endpoint, called with either one id (the per-card Apply button) or
//      several (the "Apply to selected" bulk action) — resume_id is
//      carried automatically server-side from each match's own
//      resume_id, never something this page needs to pass.

import { h, formatDate, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  getOpportunityFeed,
  updateOpportunityMatchInbox,
  bulkApply,
  type OpportunityFeedItem,
  type ResumeFeedGroup,
} from "../lib/api";
import { navigate } from "../lib/router";

function pill(text: string, cls: string): HTMLElement {
  return h("span", { class: `pill pill--${cls}` }, [text]);
}

function eligibilityPill(status: OpportunityFeedItem["eligibility_status"]): HTMLElement {
  if (status === "eligible") return pill("Eligible", "saved");
  if (status === "ineligible") return pill("Not eligible", "dismissed");
  // Deliberately neutral, never framed as an error or as ineligible —
  // "unknown" just means this opportunity hasn't stated structured
  // eligibility requirements yet (see 0023_country_neutral_eligibility.sql).
  return pill("Eligibility: Not determined", "new");
}

export async function renderOpportunityFeed(root: HTMLElement) {
  const main = renderShell(root, "/feed");
  main.append(h("div", { class: "page-loading" }, ["Loading your feed…"]));

  let items: OpportunityFeedItem[];
  let resumeGroups: ResumeFeedGroup[];
  try {
    const view = await getOpportunityFeed();
    items = view.items;
    resumeGroups = view.resume_groups;
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  // null = "All" (the default, candidate-level, resume_id IS NULL view).
  let activeResumeId: string | null = null;
  const selected = new Set<string>();
  let loadingResumeView = false;

  async function switchResume(resumeId: string | null) {
    if (resumeId === activeResumeId || loadingResumeView) return;
    loadingResumeView = true;
    selected.clear();
    draw(); // show the tab switch + a loading state immediately

    try {
      const view = await getOpportunityFeed(resumeId ?? undefined);
      items = view.items;
      resumeGroups = view.resume_groups;
      activeResumeId = resumeId;
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      loadingResumeView = false;
      draw();
    }
  }

  function draw() {
    main.innerHTML = "";
    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Feed"]),
        h("span", { class: "subtle" }, ["Opportunities matched to your profile from our tracked sources."]),
      ]),
    );

    if (resumeGroups.length > 0) {
      main.append(renderResumeTabs());
    }

    if (loadingResumeView) {
      main.append(h("div", { class: "page-loading" }, ["Loading…"]));
      return;
    }

    if (selected.size > 0) {
      main.append(renderBulkApplyBar());
    }

    if (items.length === 0) {
      main.append(
        h("div", { class: "empty" }, [
          activeResumeId
            ? "No matches for this resume yet. Check back after the next matching run."
            : "No matched opportunities yet. Complete your profile and check back after the next matching run.",
        ]),
      );
      return;
    }

    for (const item of items) main.append(renderCard(item));
  }

  // Gate R3 UI: "All" (candidate-level) + one tab per resume_group. Each
  // resume tab's label includes its own total_matches count, straight
  // from resume_groups — the "Software Development Resume → 12 matches"
  // view from the original plan.
  function renderResumeTabs(): HTMLElement {
    return h("div", { class: "tabs", style: "margin-top:24px" }, [
      h(
        "button",
        { class: `tab ${activeResumeId === null ? "tab--active" : ""}`, onClick: () => switchResume(null) },
        ["All"],
      ),
      ...resumeGroups.map((g) =>
        h(
          "button",
          { class: `tab ${activeResumeId === g.resume_id ? "tab--active" : ""}`, onClick: () => switchResume(g.resume_id) },
          [`${g.label} (${g.total_matches})`],
        ),
      ),
    ]);
  }

  function renderBulkApplyBar(): HTMLElement {
    async function applySelected() {
      const ids = [...selected];
      try {
        const { results, summary } = await bulkApply(ids);
        for (const result of results) {
          const item = items.find((i) => i.opportunity_match_id === result.opportunity_match_id);
          if (item && result.opportunity_id) {
            item.promoted_opportunity_id = result.opportunity_id;
          }
        }
        selected.clear();
        const parts = [`${summary.applied} applied`];
        if (summary.already_applied > 0) parts.push(`${summary.already_applied} already applied`);
        if (summary.failed > 0) parts.push(`${summary.failed} failed`);
        toast(parts.join(", ") + ".", summary.failed > 0 ? "error" : "success");
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    return h("div", { class: "card", style: "margin-top:16px" }, [
      h("div", { class: "spread" }, [
        h("div", {}, [`${selected.size} selected`]),
        h("div", { class: "btn-row" }, [
          h("button", { class: "btn btn--small", onClick: () => { selected.clear(); draw(); } }, ["Clear"]),
          h("button", { class: "btn btn--small btn--primary", onClick: applySelected }, ["Apply to selected"]),
        ]),
      ]),
    ]);
  }

  function renderCard(item: OpportunityFeedItem): HTMLElement {
    async function updateInbox(data: { inbox_status?: OpportunityFeedItem["inbox_status"]; is_priority?: boolean }) {
      try {
        const updated = await updateOpportunityMatchInbox(item.opportunity_match_id, data);
        item.inbox_status = updated.inbox_status;
        item.is_priority = updated.is_priority;
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function toggleSave() {
      await updateInbox({ inbox_status: item.inbox_status === "saved" ? "new" : "saved" });
    }

    async function toggleDismiss() {
      await updateInbox({ inbox_status: item.inbox_status === "dismissed" ? "new" : "dismissed" });
    }

    async function togglePriority() {
      await updateInbox({ is_priority: !item.is_priority });
    }

    // Gate R5/R6: single-item bulk-apply call — replaces the old
    // three-request manual dance this function used to do inline
    // (createOpportunity + createApplication + updateOpportunityMatchInbox,
    // with a separate try/catch just for the promotion-link step). One
    // request, dedup (exact + fuzzy cross-source) and resume_id handled
    // server-side.
    async function apply() {
      try {
        const { results } = await bulkApply([item.opportunity_match_id]);
        const result = results[0];
        if (result.status === "failed") {
          toast(result.error ?? "Could not apply.", "error");
          return;
        }
        if (result.opportunity_id) item.promoted_opportunity_id = result.opportunity_id;
        toast(result.status === "already_applied" ? "You already applied to this one." : "Application started.");
        if (result.application_id) {
          navigate(`/applications/${result.application_id}`);
        } else {
          draw();
        }
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    const metaParts = [item.company];
    if (item.location) metaParts.push(item.location);
    if (item.work_mode) metaParts.push(item.work_mode);
    if (item.employment_type) metaParts.push(item.employment_type);

    const explanation: HTMLElement[] = [];
    if (item.match_reasons.length > 0) {
      explanation.push(
        h("div", { class: "list-row__meta" }, [`Why it matched: ${item.match_reasons.join("; ")}`]),
      );
    }
    if (item.match_missing.length > 0) {
      explanation.push(h("div", { class: "list-row__meta" }, [`Doesn't match: ${item.match_missing.join("; ")}`]));
    }
    if (item.match_unknown.length > 0) {
      explanation.push(
        h("div", { class: "list-row__meta" }, [`Not enough information: ${item.match_unknown.join("; ")}`]),
      );
    }

    const alreadyApplied = item.promoted_opportunity_id !== null;

    // Gate R7: bulk-select checkbox — omitted entirely once an item is
    // already applied (nothing left to select it for).
    const checkbox = h("input", {
      type: "checkbox",
      "aria-label": `Select ${item.title}`,
      ...(selected.has(item.opportunity_match_id) ? { checked: true } : {}),
      onChange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked;
        if (checked) selected.add(item.opportunity_match_id);
        else selected.delete(item.opportunity_match_id);
        draw();
      },
    });

    return h("div", { class: "card" }, [
      h("div", { class: "spread" }, [
        h("div", { class: "spread", style: "align-items:flex-start;gap:10px" }, [
          !alreadyApplied ? h("div", { style: "padding-top:3px" }, [checkbox]) : null,
          h("div", {}, [
            h("div", { class: "list-row__title" }, [
              item.is_priority ? h("span", { class: "star" }, ["★ "]) : "",
              item.title,
              " ",
              pill(item.inbox_status === "new" ? "New" : item.inbox_status === "saved" ? "Saved" : "Dismissed", item.inbox_status),
              " ",
              eligibilityPill(item.eligibility_status),
            ]),
            h("div", { class: "list-row__meta" }, [metaParts.join(" · ")]),
            h("div", { class: "list-row__meta" }, [
              `Match score: ${item.match_score}/100${item.posted_date ? ` · Posted ${formatDate(item.posted_date)}` : ""}`,
            ]),
            item.duplicate_source_count > 0
              ? h("div", { class: "subtle" }, [
                  `Also listed on ${item.duplicate_source_count} other source${item.duplicate_source_count === 1 ? "" : "s"}`,
                ])
              : null,
            ...explanation,
          ]),
        ]),
        h("div", { class: "btn-row" }, [
          item.application_url
            ? h("a", { class: "btn btn--small", href: item.application_url, target: "_blank", rel: "noopener" }, ["Open listing"])
            : null,
          h("button", { class: "btn btn--small", onClick: togglePriority }, [item.is_priority ? "Unflag" : "Flag priority"]),
          h("button", { class: "btn btn--small", onClick: toggleSave }, [item.inbox_status === "saved" ? "Unsave" : "Save"]),
          h("button", { class: "btn btn--small", onClick: toggleDismiss }, [
            item.inbox_status === "dismissed" ? "Restore" : "Dismiss",
          ]),
          h("button", { class: "btn btn--small btn--primary", onClick: apply, disabled: alreadyApplied }, [
            alreadyApplied ? "Applied" : "Apply",
          ]),
        ]),
      ]),
    ]);
  }

  draw();
}
