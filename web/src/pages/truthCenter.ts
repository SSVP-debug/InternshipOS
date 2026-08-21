import { h, formatDate, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import { getTruthCenter, type TruthCenterEntry, type TruthCenterView } from "../lib/api";

const TYPE_LABEL: Record<string, string> = {
  education: "Education",
  work_authorization: "Work Authorization",
  skill: "Skills",
  project: "Projects",
  experience: "Experience",
  achievement: "Achievements",
  certification: "Certifications",
};

function entryCard(entry: TruthCenterEntry): HTMLElement {
  return h("div", { class: "card" }, [
    h("div", { class: "spread" }, [
      h("div", { style: "font-weight:600" }, [entry.subject_entity_label]),
      h("div", { class: "btn-row" }, [
        h("span", { class: `pill pill--${entry.status.toLowerCase()}` }, [entry.status]),
        h("span", { class: `pill pill--${entry.trust_tier}` }, [entry.trust_tier_label]),
      ]),
    ]),
    h("p", { style: "margin:8px 0" }, [entry.claim_text]),
    h("div", { class: "subtle" }, [entry.trust_tier_explanation]),
    h("div", { class: "subtle", style: "margin-top:4px" }, [entry.evidence_summary]),
    entry.evidence_link
      ? h("div", { class: "link-row" }, [
          h("a", { class: "btn btn--small", href: entry.evidence_link, target: "_blank", rel: "noopener" }, ["View evidence"]),
        ])
      : null,
    h("div", { class: "subtle", style: "margin-top:6px" }, [
      `Added ${formatDate(entry.created_at)}${entry.last_reviewed_at ? ` · Reviewed ${formatDate(entry.last_reviewed_at)}` : ""}`,
    ]),
  ]);
}

export async function renderTruthCenter(root: HTMLElement) {
  const main = renderShell(root, "/truth-center");
  main.append(h("div", { class: "page-loading" }, ["Loading Truth Center…"]));

  let view: TruthCenterView;
  try {
    view = await getTruthCenter();
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }
  main.innerHTML = "";

  main.append(
    h("div", { class: "page-header" }, [
      h("div", {}, [
        h("h1", {}, ["Truth Center"]),
        h("p", { class: "subtle" }, [
          "Every fact you've claimed about yourself, its evidence, and how trustworthy it is — this is what's allowed to be used in generated application content.",
        ]),
      ]),
    ]),
  );

  if (view.claims_needing_review_count > 0) {
    main.append(
      h("div", { class: "form-error", style: "background:var(--accent-priority-bg);color:var(--accent-priority)" }, [
        `${view.claims_needing_review_count} claim${view.claims_needing_review_count === 1 ? "" : "s"} still in draft — review them from your Profile page to confirm or dispute.`,
      ]),
    );
  }

  const types = Object.keys(view.groups);
  if (types.length === 0) {
    main.append(
      h("div", { class: "empty" }, [
        "No claims yet. Claims are created from your Profile entries (education, skills, projects, and more) once you back them with evidence.",
      ]),
    );
    return;
  }

  for (const type of types) {
    main.append(h("h2", { class: "section-title" }, [TYPE_LABEL[type] ?? type]));
    for (const entry of view.groups[type]) main.append(entryCard(entry));
  }
}
