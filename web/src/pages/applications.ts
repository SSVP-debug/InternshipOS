import { h, formatDate, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import { listApplications, type Application, type ApplicationStatus } from "../lib/api";
import { navigate } from "../lib/router";

const STATUSES: ApplicationStatus[] = ["SAVED", "APPLYING", "APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"];

function pillClass(status: string): string {
  return `pill pill--${status.toLowerCase()}`;
}

export async function renderApplications(root: HTMLElement) {
  const main = renderShell(root, "/applications");
  main.append(h("div", { class: "page-loading" }, ["Loading applications…"]));

  let applications: Application[];
  try {
    applications = await listApplications();
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }
  main.innerHTML = "";

  let filter: ApplicationStatus | "ALL" = "ALL";

  function draw() {
    main.innerHTML = "";
    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Applications"]),
        h("span", { class: "subtle" }, [`${applications.length} total`]),
      ]),
    );

    main.append(
      h(
        "div",
        { class: "tabs" },
        [
          h(
            "button",
            { class: `tab ${filter === "ALL" ? "tab--active" : ""}`, onClick: () => { filter = "ALL"; draw(); } },
            ["All"],
          ),
          ...STATUSES.map((s) =>
            h(
              "button",
              { class: `tab ${filter === s ? "tab--active" : ""}`, onClick: () => { filter = s; draw(); } },
              [s],
            ),
          ),
        ],
      ),
    );

    const visible = filter === "ALL" ? applications : applications.filter((a) => a.status === filter);

    if (visible.length === 0) {
      main.append(
        h("div", { class: "empty" }, [
          applications.length === 0
            ? "No applications yet. Start one from your "
            : "Nothing in this status.",
          applications.length === 0 ? h("a", { href: "#/opportunities" }, ["Opportunity Inbox"]) : null,
          applications.length === 0 ? "." : null,
        ]),
      );
      return;
    }

    const card = h("div", { class: "card" }, []);
    for (const a of visible) {
      card.append(
        h(
          "div",
          {
            class: "list-row",
            style: "cursor:pointer",
            onClick: () => navigate(`/applications/${a.id}`),
          },
          [
            h("div", { class: "list-row__main" }, [
              h("div", { class: "list-row__title" }, [a.opportunity?.title ?? "(opportunity removed)", " ", h("span", { class: pillClass(a.status) }, [a.status])]),
              h("div", { class: "list-row__meta" }, [
                `${a.opportunity?.company ?? ""}${a.next_action_date ? ` · Next action ${formatDate(a.next_action_date)}` : ""}`,
              ]),
            ]),
            h("span", { class: "subtle" }, ["Updated ", formatDate(a.updated_at)]),
          ],
        ),
      );
    }
    main.append(card);
  }

  draw();
}
