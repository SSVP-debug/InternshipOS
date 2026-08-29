import { h, formatDate, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  getOpportunityFeed,
  updateOpportunityMatchInbox,
  createOpportunity,
  createApplication,
  ApiError,
  type OpportunityFeedItem,
  type Opportunity,
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
  try {
    const view = await getOpportunityFeed();
    items = view.items;
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  function draw() {
    main.innerHTML = "";
    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Feed"]),
        h("span", { class: "subtle" }, ["Opportunities matched to your profile from our tracked sources."]),
      ]),
    );

    if (items.length === 0) {
      main.append(
        h("div", { class: "empty" }, [
          "No matched opportunities yet. Complete your profile and check back after the next matching run.",
        ]),
      );
      return;
    }

    for (const item of items) main.append(renderCard(item));
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

    async function apply() {
      try {
        const created = await createOpportunity({
          title: item.title,
          company: item.company,
          location: item.location ?? undefined,
          work_mode: (item.work_mode as Opportunity["work_mode"]) ?? undefined,
          employment_type: item.employment_type as Opportunity["employment_type"],
          application_url: item.application_url ?? undefined,
          source: "job_board",
        });
        const application = await createApplication({ opportunity_id: created.id });

        // Record which application this match was promoted into. This is
        // provenance, not the primary action — the application above has
        // already succeeded by this point, so a failure here is logged
        // and shown as a soft, non-blocking note rather than treated as
        // the apply attempt itself failing (the candidate should still
        // land on their new application either way).
        try {
          const updated = await updateOpportunityMatchInbox(item.opportunity_match_id, {
            promoted_opportunity_id: created.id,
          });
          item.promoted_opportunity_id = updated.promoted_opportunity_id;
        } catch (linkErr) {
          console.warn("Could not record promoted_opportunity_id on the match:", linkErr);
          toast("Application created, but the feed card couldn't be marked as applied.", "error");
        }

        toast("Application started.");
        navigate(`/applications/${application.id}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          toast("You already have an application for this opportunity.", "error");
        } else {
          toast(errorMessage(err), "error");
        }
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

    return h("div", { class: "card" }, [
      h("div", { class: "spread" }, [
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
        h("div", { class: "btn-row" }, [
          item.application_url
            ? h("a", { class: "btn btn--small", href: item.application_url, target: "_blank", rel: "noopener" }, ["Open listing"])
            : null,
          h("button", { class: "btn btn--small", onClick: togglePriority }, [item.is_priority ? "Unflag" : "Flag priority"]),
          h("button", { class: "btn btn--small", onClick: toggleSave }, [item.inbox_status === "saved" ? "Unsave" : "Save"]),
          h("button", { class: "btn btn--small", onClick: toggleDismiss }, [
            item.inbox_status === "dismissed" ? "Restore" : "Dismiss",
          ]),
          h("button", { class: "btn btn--small btn--primary", onClick: apply, disabled: item.promoted_opportunity_id !== null }, [
            item.promoted_opportunity_id !== null ? "Applied" : "Apply",
          ]),
        ]),
      ]),
    ]);
  }

  draw();
}
