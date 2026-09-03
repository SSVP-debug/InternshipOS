// resumes.ts — Gate R7: resume management page. Create/edit resumes,
// archive/unarchive them, and assign/remove skills. No DELETE UI here at
// all — matches resume.ts's own no-hard-delete-route decision (see that
// route's header comment); archiving is the only removal action exposed.

import { h, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  listResumes,
  createResume,
  updateResume,
  addResumeSkill,
  removeResumeSkill,
  skillApi,
  ApiError,
  type Resume,
  type Skill,
} from "../lib/api";

function pill(text: string, cls: string): HTMLElement {
  return h("span", { class: `pill pill--${cls}` }, [text]);
}

export async function renderResumes(root: HTMLElement) {
  const main = renderShell(root, "/resumes");
  main.append(h("div", { class: "page-loading" }, ["Loading your resumes…"]));

  let resumes: Resume[];
  let allSkills: Skill[];
  try {
    [resumes, allSkills] = await Promise.all([listResumes(), skillApi.list()]);
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  let filter: "active" | "archived" = "active";
  let editingId: string | null = null;

  function draw() {
    main.innerHTML = "";
    main.append(
      h("div", { class: "page-header" }, [
        h("h1", {}, ["Resumes"]),
        h("span", { class: "subtle" }, [
          "Keep a separate resume per role you're targeting — matching and your feed can be scoped to just one.",
        ]),
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
          ["Active"],
        ),
        h(
          "button",
          {
            class: `tab ${filter === "archived" ? "tab--active" : ""}`,
            onClick: () => {
              filter = "archived";
              draw();
            },
          },
          ["Archived"],
        ),
      ]),
    );

    const visible = resumes.filter((r) => (filter === "active" ? r.is_active : !r.is_active));

    if (visible.length === 0) {
      main.append(
        h("div", { class: "empty" }, [
          filter === "active"
            ? "No active resumes yet. Add one above — e.g. \"Software Development\" or \"AI/ML\"."
            : "Nothing archived.",
        ]),
      );
      return;
    }

    for (const r of visible) main.append(renderCard(r));
  }

  function renderAddForm(): HTMLElement {
    const labelField = h("input", { type: "text", required: true, placeholder: "Software Development" });
    const categoryField = h("input", { type: "text", placeholder: "Software Engineering (optional)" });
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
    const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Add resume"]);

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          errorBox.style.display = "none";
          submitBtn.setAttribute("disabled", "");
          try {
            const created = await createResume({
              label: (labelField as HTMLInputElement).value,
              target_role_category: (categoryField as HTMLInputElement).value || undefined,
            });
            resumes = [created, ...resumes];
            (labelField as HTMLInputElement).value = "";
            (categoryField as HTMLInputElement).value = "";
            filter = "active";
            toast("Resume added.");
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
          h("div", { class: "field" }, [h("label", {}, ["Label"]), labelField]),
          h("div", { class: "field" }, [h("label", {}, ["Target role category"]), categoryField]),
        ]),
        errorBox,
        h("div", { class: "btn-row" }, [submitBtn]),
      ],
    );

    return h("div", { class: "card" }, [form]);
  }

  function renderCard(r: Resume): HTMLElement {
    async function toggleArchive() {
      try {
        const updated = await updateResume(r.id, { is_active: !r.is_active });
        Object.assign(r, updated);
        toast(updated.is_active ? "Resume restored." : "Resume archived.");
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function removeSkill(skillId: string) {
      try {
        await removeResumeSkill(r.id, skillId);
        r.skills = r.skills.filter((s) => s.id !== skillId);
        draw();
      } catch (err) {
        toast(errorMessage(err), "error");
      }
    }

    async function addSkill(skillId: string) {
      try {
        const added = await addResumeSkill(r.id, skillId);
        r.skills = [...r.skills, added];
        draw();
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          toast("That skill is already on this resume.", "error");
        } else {
          toast(errorMessage(err), "error");
        }
      }
    }

    const attachedIds = new Set(r.skills.map((s) => s.id));
    const availableSkills = allSkills.filter((s) => !attachedIds.has(s.id));

    const skillPicker =
      availableSkills.length > 0
        ? h(
            "select",
            {
              onChange: (e: Event) => {
                const select = e.target as HTMLSelectElement;
                if (select.value) {
                  addSkill(select.value);
                  select.value = "";
                }
              },
            },
            [
              h("option", { value: "" }, ["+ Add a skill…"]),
              ...availableSkills.map((s) => h("option", { value: s.id }, [s.name])),
            ],
          )
        : h("span", { class: "subtle" }, ["All your skills are already on this resume."]);

    const skillList =
      r.skills.length > 0
        ? h(
            "div",
            { class: "btn-row", style: "flex-wrap:wrap;margin-top:8px" },
            r.skills.map((s) =>
              h("span", { class: "pill pill--saved" }, [
                s.name,
                " ",
                h(
                  "button",
                  {
                    class: "btn--inline-remove",
                    "aria-label": `Remove ${s.name}`,
                    onClick: () => removeSkill(s.id),
                  },
                  ["×"],
                ),
              ]),
            ),
          )
        : h("div", { class: "subtle", style: "margin-top:8px" }, ["No skills assigned yet."]);

    const body: (Node | string | null)[] = [
      h("div", { class: "spread" }, [
        h("div", {}, [
          h("div", { class: "list-row__title" }, [
            r.label,
            " ",
            pill(r.is_active ? "Active" : "Archived", r.is_active ? "saved" : "dismissed"),
          ]),
          r.target_role_category ? h("div", { class: "list-row__meta" }, [r.target_role_category]) : null,
        ]),
        h("div", { class: "btn-row" }, [
          h("button", { class: "btn btn--small", onClick: () => { editingId = editingId === r.id ? null : r.id; draw(); } }, [
            editingId === r.id ? "Cancel" : "Edit",
          ]),
          h("button", { class: "btn btn--small", onClick: toggleArchive }, [r.is_active ? "Archive" : "Restore"]),
        ]),
      ]),
    ];

    if (editingId === r.id) {
      body.push(renderEditForm(r));
    } else {
      body.push(skillList, h("div", { style: "margin-top:8px" }, [skillPicker]));
    }

    return h("div", { class: "card" }, body);
  }

  function renderEditForm(r: Resume): HTMLElement {
    const labelField = h("input", { type: "text", required: true, value: r.label });
    const categoryField = h("input", { type: "text", value: r.target_role_category ?? "", placeholder: "Optional" });
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
    const saveBtn = h("button", { class: "btn btn--primary btn--small", type: "submit" }, ["Save"]);

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          errorBox.style.display = "none";
          saveBtn.setAttribute("disabled", "");
          try {
            const label = (labelField as HTMLInputElement).value;
            const category = (categoryField as HTMLInputElement).value;
            const updated = await updateResume(r.id, {
              label,
              // Empty string means "clear it" here — sent as explicit
              // null, matching ResumeUpdateRequestSchema's own nullable
              // support, rather than omitting the field (which would
              // leave a previously-set category untouched instead).
              target_role_category: category || null,
            });
            Object.assign(r, updated);
            editingId = null;
            toast("Resume updated.");
            draw();
          } catch (err) {
            errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
            errorBox.style.display = "block";
          } finally {
            saveBtn.removeAttribute("disabled");
          }
        },
      },
      [
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Label"]), labelField]),
          h("div", { class: "field" }, [h("label", {}, ["Target role category"]), categoryField]),
        ]),
        errorBox,
        h("div", { class: "btn-row" }, [saveBtn]),
      ],
    );

    return form;
  }

  draw();
}
