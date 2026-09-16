// opportunityFeed.ts — the candidate's matched-opportunities feed.
//
// GATE R7 CHANGES:
//   1. Resume tabs ("All" + one per active resume, from resume_groups) —
//      switching tabs re-fetches getOpportunityFeed(resumeId), which
//      swaps `items` to that resume's scoped matches (Gate R3's own
//      contract — see api.ts's getOpportunityFeed comment).
//   2. "Start application" now calls bulkApply() (Gate R5/R6) instead of
//      the old three-request manual dance (createOpportunity +
//      createApplication + updateOpportunityMatchInbox) this file used to
//      do inline. Same endpoint, called with either one id (the per-card
//      "Start application" button) or several (the "Start applications"
//      bulk action) — resume_id is carried automatically server-side from
//      each match's own resume_id, never something this page needs to
//      pass. Gate A2.1: the button/toast copy was renamed from "Apply" /
//      "Applied" to "Start application" / "Application started" — the
//      underlying action has always been an internal tracking record
//      (application.status starts at SAVED), never an external employer
//      submission, and the old labels implied otherwise.

import { h, formatDate, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  getOpportunityFeed,
  updateOpportunityMatchInbox,
  bulkApply,
  bulkSubmitApplicationsToAts,
  listApplications,
  submitApplicationToAts,
  type OpportunityFeedItem,
  type ResumeFeedGroup,
} from "../lib/api";
import { feedBadgeCount } from "../lib/navBadges";
import { navigate } from "../lib/router";
import { isLeverPostingUrl, atsErrorMessage } from "../lib/ats";

function pill(text: string, cls: string): HTMLElement {
  return h("span", { class: `pill pill--${cls}` }, [text]);
}

function eligibilityPill(status: OpportunityFeedItem["eligibility_status"]): HTMLElement {
  if (status === "eligible") return pill("Eligible", "saved");
  if (status === "ineligible") return pill("Not eligible", "dismissed");
  // Deliberately neutral, never framed as an error or as ineligible.
  // "unknown" can mean either the opportunity hasn't stated a structured
  // eligibility requirement (see 0023_country_neutral_eligibility.sql) or
  // that InternshipOS doesn't have enough of the candidate's own profile
  // to evaluate a requirement the opportunity did state — the pill stays
  // a neutral summary either way; the per-item "Not enough information:
  // …" line below (item.match_unknown) is what actually says which.
  return pill("Eligibility: Not enough info", "new");
}

export async function renderOpportunityFeed(root: HTMLElement) {
  let main = renderShell(root, "/feed");
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
    // Small Phase B follow-up ("nav badge polish"): re-mount the shell's
    // nav on every draw so the Feed sidebar link's badge stays in sync as
    // matches are saved/dismissed/applied — see navBadges.ts's own header
    // for why this is Feed's own, self-contained count (computed from
    // this page's own already-fetched `items`, not a new API call).
    main = renderShell(root, "/feed", { "/feed": feedBadgeCount(items) });
    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Feed"]),
        h("span", { class: "subtle" }, ["Opportunities matched to your profile from our tracked sources."]),
      ]),
    );

    // Gate R8 follow-up — directly answers "how much of my actual feed is
    // even auto-apply eligible" rather than leaving that as a question
    // the person has to answer by eyeballing individual cards. Counted
    // over whatever `items` currently holds (respects the active resume
    // tab, same as every other count on this page) — not a separate API
    // call, since isLeverPostingUrl is a pure client-side check against
    // data already fetched.
    if (items.length > 0) {
      const leverEligibleCount = items.filter((item) => isLeverPostingUrl(item.application_url)).length;
      main.append(
        h("div", { class: "subtle", style: "margin-bottom:12px" }, [
          leverEligibleCount > 0
            ? `⚡ ${leverEligibleCount} of ${items.length} postings here are Lever-hosted (auto-apply eligible).`
            : `None of the ${items.length} postings here are Lever-hosted — auto-apply isn't available for this batch yet.`,
        ]),
      );
    }

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
        const parts = [`${summary.applied} started`];
        if (summary.already_applied > 0) parts.push(`${summary.already_applied} already started`);
        if (summary.failed > 0) parts.push(`${summary.failed} failed`);
        toast(parts.join(", ") + ".", summary.failed > 0 ? "error" : "success");
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    // Gate R8 follow-up — of the selected matches, only the ones that
    // are (a) Lever-hosted and (b) not already auto-submitted are worth
    // sending to the bulk endpoint at all; filtering client-side first
    // avoids a confusing "N rejected" summary full of items that were
    // never going to qualify. The backend's own 5-item cap
    // (BulkSubmitToAtsRequestSchema) is still the authority — this is
    // just a courtesy trim so the confirm dialog's count matches what
    // will actually be attempted.
    const MAX_BULK_SUBMIT = 5;
    const eligibleForAutoApply = [...selected].filter((id) => {
      const item = items.find((i) => i.opportunity_match_id === id);
      return item ? isLeverPostingUrl(item.application_url) && !item.ats_submitted_at : false;
    });
    const autoApplyIds = eligibleForAutoApply.slice(0, MAX_BULK_SUBMIT);
    const truncatedCount = eligibleForAutoApply.length - autoApplyIds.length;

    async function autoApplySelected() {
      try {
        const preview = await bulkSubmitApplicationsToAts(autoApplyIds, { dry_run: true });
        const eligible = preview.results.filter((r) => r.status === "dry_run");
        if (eligible.length === 0) {
          toast("None of the selected matches could be auto-submitted right now.", "error");
          return;
        }
        const summaryLines = eligible.map((r) => `• ${r.would_submit?.posting_title ?? r.opportunity_match_id}`).join("\n");
        const skipped = preview.results.length - eligible.length;
        const confirmed = confirm(
          `Submit ${eligible.length} application(s) to Lever now?\n\n${summaryLines}\n\n` +
            (skipped > 0 ? `${skipped} other selected match(es) aren't eligible and will be skipped.\n\n` : "") +
            (truncatedCount > 0 ? `${truncatedCount} more selected match(es) were left out of this batch (limit ${MAX_BULK_SUBMIT} at a time).\n\n` : "") +
            "This sends real applications to these employers and can't be undone.",
        );
        if (!confirmed) return;

        const { results, summary } = await bulkSubmitApplicationsToAts(eligible.map((r) => r.opportunity_match_id), { dry_run: false });
        for (const result of results) {
          if (result.status !== "submitted") continue;
          const item = items.find((i) => i.opportunity_match_id === result.opportunity_match_id);
          if (item) {
            item.ats_provider = "lever";
            item.ats_submitted_at = new Date().toISOString();
          }
        }
        const parts = [`${summary.submitted} submitted`];
        if (summary.failed > 0) parts.push(`${summary.failed} failed`);
        if (summary.rejected > 0) parts.push(`${summary.rejected} rejected`);
        toast(parts.join(", ") + ".", summary.failed > 0 || summary.rejected > 0 ? "error" : "success");
        selected.clear();
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
          h("button", { class: "btn btn--small btn--primary", onClick: applySelected }, ["Start applications"]),
          autoApplyIds.length > 0
            ? h("button", { class: "btn btn--small btn--primary", onClick: autoApplySelected }, [`⚡ Auto-apply ${autoApplyIds.length} (Lever)`])
            : null,
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
          toast(result.error ?? "Could not start an application.", "error");
          return;
        }
        if (result.opportunity_id) item.promoted_opportunity_id = result.opportunity_id;
        toast(result.status === "already_applied" ? "You already started an application for this one." : "Application started.");
        if (result.application_id) {
          navigate(`/applications/${result.application_id}`);
        } else {
          draw();
        }
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    // Gate R8 — resolves (creating if needed) the tracked application
    // behind this match, so auto-apply works whether or not the
    // candidate already clicked "Start application" first. Mirrors
    // apply()'s own bulkApply call for the "not yet tracked" case; the
    // "already tracked" case has to fall back to a listApplications scan
    // because bulk-apply's own "already_applied" result never carries an
    // application_id (see api/src/routes/opportunity-feed.ts — only the
    // opportunity_id, since the match row itself doesn't need to know
    // which application it became once it's promoted).
    async function resolveApplicationId(): Promise<string | null> {
      if (item.promoted_opportunity_id) {
        const apps = await listApplications();
        return apps.find((a) => a.opportunity_id === item.promoted_opportunity_id)?.id ?? null;
      }
      const { results } = await bulkApply([item.opportunity_match_id]);
      const result = results[0];
      if (result.status === "failed") {
        throw new Error(result.error ?? "Could not start an application.");
      }
      if (result.opportunity_id) item.promoted_opportunity_id = result.opportunity_id;
      return result.application_id ?? null;
    }

    // The feed-level "single click" version of auto-apply: tracks the
    // application if needed, runs a dry run, shows the candidate exactly
    // what would be sent in a native confirm() dialog, and only submits
    // for real if they confirm — same two-step safety posture as the
    // application detail page's "Preview" / "Submit for real" buttons,
    // just collapsed into one click plus one confirmation instead of a
    // page navigation in between.
    async function autoApplyViaLever() {
      autoApplyBtn.setAttribute("disabled", "");
      try {
        const applicationId = await resolveApplicationId();
        if (!applicationId) {
          toast("Couldn't find or create a tracked application for this match.", "error");
          return;
        }
        const preview = await submitApplicationToAts(applicationId, { dry_run: true });
        if (!preview.ok) {
          toast(atsErrorMessage(preview.error, preview.message), "error");
          return;
        }
        if (!preview.dry_run) return; // can't happen (dry_run: true above); keeps TS happy
        const ws = preview.would_submit;
        const confirmed = confirm(
          `Submit to "${ws.posting_title}" on Lever now?\n\n` +
            `Name: ${ws.name}\nEmail: ${ws.email}${ws.phone ? `\nPhone: ${ws.phone}` : ""}\nResume: ${ws.resume_title}\n\n` +
            "This sends a real application to the employer and can't be undone.",
        );
        if (!confirmed) return;

        const result = await submitApplicationToAts(applicationId, { dry_run: false });
        if (!result.ok) {
          toast(atsErrorMessage(result.error, result.message), "error");
          return;
        }
        if (result.dry_run) return; // can't happen (dry_run: false above); keeps TS happy
        item.ats_provider = result.application.ats_provider ?? "lever";
        item.ats_submitted_at = result.application.ats_submitted_at ?? new Date().toISOString();
        toast("Submitted to Lever.");
      } catch (err) {
        toast(errorMessage(err), "error");
      } finally {
        draw();
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
    const alreadyAutoApplied = Boolean(item.ats_submitted_at);
    const showAutoApply = isLeverPostingUrl(item.application_url) && !alreadyAutoApplied;
    const autoApplyBtn = h(
      "button",
      { class: "btn btn--small btn--primary", onClick: autoApplyViaLever, title: "Submits directly through Lever — you'll be asked to confirm first." },
      ["⚡ Auto-apply (Lever)"],
    );

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
            alreadyApplied ? "Application started" : "Start application",
          ]),
          showAutoApply ? autoApplyBtn : alreadyAutoApplied ? pill(`Submitted via ${item.ats_provider ?? "Lever"}`, "applied") : null,
        ]),
      ]),
    ]);
  }

  draw();
}
