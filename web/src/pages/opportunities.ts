import { h, formatDate, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  listOpportunities,
  createOpportunity,
  updateOpportunityInbox,
  deleteOpportunity,
  createApplication,
  ApiError,
  type Opportunity,
} from "../lib/api";
import { navigate } from "../lib/router";

function pill(text: string, cls: string): HTMLElement {
  return h("span", { class: `pill pill--${cls}` }, [text]);
}

export async function renderOpportunities(root: HTMLElement) {
  const main = renderShell(root, "/opportunities");
  main.append(h("div", { class: "page-loading" }, ["Loading opportunities…"]));

  let opportunities: Opportunity[];
  try {
    opportunities = await listOpportunities({ includeDismissed: true });
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  let filter: "active" | "dismissed" = "active";

  function draw() {
    main.innerHTML = "";
    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Opportunity Inbox"]),
        h("span", { class: "subtle" }, ["Add anything you find — a link from a friend, a career fair flyer, a job board post."]),
      ]),
    );

    main.append(renderAddForm());

    main.append(
      h("div", { class: "tabs", style: "margin-top:24px" }, [
        h(
          "button",
          {
            class: `tab ${filter === "active" ? "tab--active" : ""}`,
            onClick: () => {
              filter = "active";
              draw();
            },
          },
          ["Inbox"],
        ),
        h(
          "button",
          {
            class: `tab ${filter === "dismissed" ? "tab--active" : ""}`,
            onClick: () => {
              filter = "dismissed";
              draw();
            },
          },
          ["Dismissed"],
        ),
      ]),
    );

    const visible = opportunities.filter((o) => (filter === "active" ? o.inbox_status !== "dismissed" : o.inbox_status === "dismissed"));

    if (visible.length === 0) {
      main.append(h("div", { class: "empty" }, [filter === "active" ? "Your inbox is empty. Add something above." : "Nothing dismissed."]));
      return;
    }

    for (const o of visible) main.append(renderRow(o));
  }

  function renderAddForm(): HTMLElement {
    const titleField = h("input", { type: "text", required: true, placeholder: "Software Engineering Intern" });
    const companyField = h("input", { type: "text", required: true, placeholder: "Acme Corp" });
    const urlField = h("input", { type: "url", placeholder: "https://…/careers/123" });
    const deadlineField = h("input", { type: "date" });
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
    let expanded = false;

    const locationField = h("input", { type: "text", placeholder: "Remote, or city" });
    const workModeField = h("select", {}, [
      h("option", { value: "" }, ["Work mode (optional)"]),
      h("option", { value: "remote" }, ["Remote"]),
      h("option", { value: "hybrid" }, ["Hybrid"]),
      h("option", { value: "onsite" }, ["On-site"]),
    ]);
    const sourceField = h("select", {}, [
      ["manual", "Added manually"],
      ["referral", "Referral"],
      ["company_site", "Company site"],
      ["job_board", "Job board"],
      ["career_fair", "Career fair"],
      ["other", "Other"],
    ].map(([v, label]) => h("option", { value: v }, [label])));

    const moreFields = h("div", { class: "form-row", style: expanded ? "" : "display:none" }, [
      h("div", { class: "field" }, [h("label", {}, ["Location"]), locationField]),
      h("div", { class: "field" }, [h("label", {}, ["Work mode"]), workModeField]),
      h("div", { class: "field" }, [h("label", {}, ["Source"]), sourceField]),
    ]);

    const toggleBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn--ghost btn--small",
        onClick: () => {
          expanded = !expanded;
          moreFields.style.display = expanded ? "flex" : "none";
          toggleBtn.textContent = expanded ? "Fewer details" : "More details";
        },
      },
      ["More details"],
    );

    const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Add to inbox"]);

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          errorBox.style.display = "none";
          submitBtn.setAttribute("disabled", "");
          try {
            const created = await createOpportunity({
              title: (titleField as HTMLInputElement).value,
              company: (companyField as HTMLInputElement).value,
              application_url: (urlField as HTMLInputElement).value || undefined,
              deadline_date: (deadlineField as HTMLInputElement).value || undefined,
              location: (locationField as HTMLInputElement).value || undefined,
              work_mode: ((workModeField as HTMLSelectElement).value || undefined) as Opportunity["work_mode"],
              source: (sourceField as HTMLSelectElement).value as Opportunity["source"],
            });
            opportunities = [created, ...opportunities];
            (titleField as HTMLInputElement).value = "";
            (companyField as HTMLInputElement).value = "";
            (urlField as HTMLInputElement).value = "";
            (deadlineField as HTMLInputElement).value = "";
            toast("Added to your inbox.");
            draw();
          } catch (err) {
            errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
            errorBox.style.display = "block";
          } finally {
            submitBtn.removeAttribute("disabled");
          }
        },
      },
      [
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Title"]), titleField]),
          h("div", { class: "field" }, [h("label", {}, ["Company"]), companyField]),
        ]),
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Application link (optional)"]), urlField]),
          h("div", { class: "field" }, [h("label", {}, ["Deadline (optional)"]), deadlineField]),
        ]),
        moreFields,
        errorBox,
        h("div", { class: "btn-row" }, [submitBtn, toggleBtn]),
      ],
    );

    return h("div", { class: "card" }, [form]);
  }

  function renderRow(o: Opportunity): HTMLElement {
    const statusPill = pill(o.inbox_status === "new" ? "New" : o.inbox_status === "saved" ? "Saved" : "Dismissed", o.inbox_status);

    async function toggleSave() {
      try {
        const updated = await updateOpportunityInbox(o.id, { inbox_status: o.inbox_status === "saved" ? "new" : "saved" });
        Object.assign(o, updated);
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function toggleDismiss() {
      try {
        const updated = await updateOpportunityInbox(o.id, {
          inbox_status: o.inbox_status === "dismissed" ? "new" : "dismissed",
        });
        Object.assign(o, updated);
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function togglePriority() {
      try {
        const updated = await updateOpportunityInbox(o.id, { is_priority: !o.is_priority });
        Object.assign(o, updated);
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function startApplication() {
      try {
        const application = await createApplication({ opportunity_id: o.id });
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

    async function remove() {
      if (!confirm(`Remove "${o.title}" from your inbox? This cannot be undone.`)) return;
      try {
        await deleteOpportunity(o.id);
        opportunities = opportunities.filter((x) => x.id !== o.id);
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    return h("div", { class: "card" }, [
      h("div", { class: "spread" }, [
        h("div", {}, [
          h("div", { class: "list-row__title" }, [
            o.is_priority ? h("span", { class: "star" }, ["★ "]) : "",
            o.title,
            " ",
            statusPill,
          ]),
          h("div", { class: "list-row__meta" }, [
            `${o.company}${o.location ? ` · ${o.location}` : ""}${o.work_mode ? ` · ${o.work_mode}` : ""}`,
          ]),
          o.deadline_date ? h("div", { class: "list-row__meta" }, [`Deadline: ${formatDate(o.deadline_date)}`]) : null,
        ]),
        h("div", { class: "btn-row" }, [
          o.application_url ? h("a", { class: "btn btn--small", href: o.application_url, target: "_blank", rel: "noopener" }, ["Open listing"]) : null,
          h("button", { class: "btn btn--small", onClick: togglePriority }, [o.is_priority ? "Unflag" : "Flag priority"]),
          h("button", { class: "btn btn--small", onClick: toggleSave }, [o.inbox_status === "saved" ? "Unsave" : "Save"]),
          h("button", { class: "btn btn--small", onClick: toggleDismiss }, [o.inbox_status === "dismissed" ? "Restore" : "Dismiss"]),
          h("button", { class: "btn btn--small btn--primary", onClick: startApplication }, ["Start application"]),
          h("button", { class: "btn btn--small btn--danger", onClick: remove }, ["Delete"]),
        ]),
      ]),
    ]);
  }

  draw();
}
