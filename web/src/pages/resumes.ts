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
  evidenceSourceApi,
  getEvidenceDownloadUrl,
  uploadResumeFile,
  validateResumeFile,
  RESUME_FILE_ACCEPT,
  grantConsent,
  ApiError,
  type Resume,
  type Skill,
  type EvidenceSource,
} from "../lib/api";

function pill(text: string, cls: string): HTMLElement {
  return h("span", { class: `pill pill--${cls}` }, [text]);
}

// Uploads (if a file was chosen) and returns the new evidence_source row,
// or undefined if the field was left empty. A consent_required failure
// propagates as-is — withConsentRecovery (below) is what turns it into
// the inline "grant and retry" affordance, the same one profile.ts uses
// for data_processing consent. A candidate can reach Resumes without ever
// having granted document_upload_storage, and without this they'd have no
// way to discover why every upload 403s.
async function uploadIfChosen(fileField: HTMLInputElement): Promise<EvidenceSource | undefined> {
  const file = fileField.files?.[0];
  if (!file) return undefined;

  const validationError = validateResumeFile(file);
  if (validationError) throw new ApiError(400, "invalid_file", validationError);

  return uploadResumeFile(file);
}

// Shared by both the add form and the edit form: runs `attempt`, and on a
// consent_required error, swaps the error box for a "Grant" button that
// re-runs `attempt` once consent is granted, instead of a dead-end error.
async function withConsentRecovery(errorBox: HTMLElement, attempt: () => Promise<void>) {
  try {
    await attempt();
  } catch (err) {
    if (err instanceof ApiError && err.code === "consent_required") {
      errorBox.innerHTML = "";
      errorBox.style.display = "block";
      errorBox.append(
        h("span", {}, ["Uploading a resume file requires granting document upload consent. "]),
        h(
          "button",
          {
            type: "button",
            class: "btn btn--small",
            onClick: async () => {
              try {
                await grantConsent("document_upload_storage");
                toast("Consent granted.");
                await withConsentRecovery(errorBox, attempt);
              } catch (grantErr) {
                errorBox.textContent = errorMessage(grantErr);
              }
            },
          },
          ["Grant consent"],
        ),
      );
      return;
    }
    errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
    errorBox.style.display = "block";
  }
}

export async function renderResumes(root: HTMLElement) {
  const main = renderShell(root, "/resumes");
  main.append(h("div", { class: "page-loading" }, ["Loading your resumes…"]));

  let resumes: Resume[];
  let allSkills: Skill[];
  let evidenceSources: EvidenceSource[];
  try {
    [resumes, allSkills, evidenceSources] = await Promise.all([listResumes(), skillApi.list(), evidenceSourceApi.list()]);
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  // Keyed lookup for displaying the filename already attached to a resume
  // without a second round-trip per resume — reuses the same GET
  // /evidence-sources list every other Truth Center surface already
  // fetches, rather than adding a resume-specific "embed the evidence
  // source" backend change.
  const evidenceById = new Map(evidenceSources.map((e) => [e.id, e]));

  async function openDownload(evidenceSourceId: string) {
    try {
      const url = await getEvidenceDownloadUrl(evidenceSourceId);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
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
    const fileField = h("input", { type: "file", accept: RESUME_FILE_ACCEPT }) as HTMLInputElement;
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
    const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Add resume"]);

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: (e: Event) => {
          e.preventDefault();
          errorBox.innerHTML = "";
          errorBox.style.display = "none";
          submitBtn.setAttribute("disabled", "");
          withConsentRecovery(errorBox, async () => {
            const evidenceSource = await uploadIfChosen(fileField);
            const created = await createResume({
              label: (labelField as HTMLInputElement).value,
              target_role_category: (categoryField as HTMLInputElement).value || undefined,
              evidence_source_id: evidenceSource?.id,
            });
            if (evidenceSource) evidenceById.set(evidenceSource.id, evidenceSource);
            resumes = [created, ...resumes];
            (labelField as HTMLInputElement).value = "";
            (categoryField as HTMLInputElement).value = "";
            fileField.value = "";
            filter = "active";
            toast("Resume added.");
            draw();
          }).finally(() => submitBtn.removeAttribute("disabled"));
        },
      },
      [
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Label"]), labelField]),
          h("div", { class: "field" }, [h("label", {}, ["Target role category"]), categoryField]),
        ]),
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [
            h("label", {}, ["Resume file (optional)"]),
            fileField,
            h("span", { class: "subtle" }, ["PDF, Word, or image — up to 10 MB."]),
          ]),
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

    const attachedFile = r.evidence_source_id ? evidenceById.get(r.evidence_source_id) : undefined;
    const fileRow = h("div", { class: "list-row__meta", style: "margin-top:4px" }, [
      attachedFile
        ? h("span", {}, [
            `File: ${attachedFile.title} `,
            h(
              "button",
              { type: "button", class: "btn btn--small", onClick: () => openDownload(attachedFile.id) },
              ["Download"],
            ),
          ])
        : h("span", { class: "subtle" }, ["No file attached."]),
    ]);

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
      body.push(fileRow, skillList, h("div", { style: "margin-top:8px" }, [skillPicker]));
    }

    return h("div", { class: "card" }, body);
  }

  function renderEditForm(r: Resume): HTMLElement {
    const labelField = h("input", { type: "text", required: true, value: r.label });
    const categoryField = h("input", { type: "text", value: r.target_role_category ?? "", placeholder: "Optional" });
    const fileField = h("input", { type: "file", accept: RESUME_FILE_ACCEPT }) as HTMLInputElement;
    const currentFile = r.evidence_source_id ? evidenceById.get(r.evidence_source_id) : undefined;
    let removeFile = false;
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
    const saveBtn = h("button", { class: "btn btn--primary btn--small", type: "submit" }, ["Save"]);

    const currentFileRow = currentFile
      ? h("div", { class: "field--checkbox" }, [
          h("input", {
            type: "checkbox",
            id: `remove-file-${r.id}`,
            onChange: (e: Event) => {
              removeFile = (e.target as HTMLInputElement).checked;
            },
          }),
          h("label", { for: `remove-file-${r.id}` }, [`Remove current file (${currentFile.title})`]),
        ])
      : null;

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: (e: Event) => {
          e.preventDefault();
          errorBox.innerHTML = "";
          errorBox.style.display = "none";
          saveBtn.setAttribute("disabled", "");
          withConsentRecovery(errorBox, async () => {
            const label = (labelField as HTMLInputElement).value;
            const category = (categoryField as HTMLInputElement).value;
            const newEvidenceSource = await uploadIfChosen(fileField);

            // evidence_source_id resolution: a new upload always wins; the
            // "remove current file" checkbox clears it (explicit null,
            // matching ResumeUpdateRequestSchema's nullable support);
            // otherwise leave whatever was there alone by simply not
            // sending the field.
            const evidenceUpdate = newEvidenceSource
              ? { evidence_source_id: newEvidenceSource.id }
              : removeFile
                ? { evidence_source_id: null }
                : {};

            const updated = await updateResume(r.id, {
              label,
              target_role_category: category || null,
              ...evidenceUpdate,
            });
            Object.assign(r, updated);
            if (newEvidenceSource) evidenceById.set(newEvidenceSource.id, newEvidenceSource);

            // Best-effort cleanup: a replaced/removed file's old
            // evidence_source row (and its Storage object, purged by
            // evidence-source.ts's own DELETE handler) would otherwise sit
            // around unreferenced forever. Safe here specifically because
            // every evidence_source this page creates is created solely
            // for one resume — never shared with a Truth Center claim —
            // so nothing else can be pointing at it. Failure is silent:
            // the resume update above already succeeded, and an orphaned
            // file is a cosmetic Storage-hygiene issue, not a reason to
            // tell the candidate their save failed.
            if (currentFile && (newEvidenceSource || removeFile)) {
              evidenceSourceApi.remove(currentFile.id).catch(() => {});
            }

            editingId = null;
            toast("Resume updated.");
            draw();
          }).finally(() => saveBtn.removeAttribute("disabled"));
        },
      },
      [
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Label"]), labelField]),
          h("div", { class: "field" }, [h("label", {}, ["Target role category"]), categoryField]),
        ]),
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [
            h("label", {}, [currentFile ? "Replace resume file" : "Resume file"]),
            fileField,
            h("span", { class: "subtle" }, ["PDF, Word, or image — up to 10 MB."]),
          ]),
        ]),
        currentFileRow,
        errorBox,
        h("div", { class: "btn-row" }, [saveBtn]),
      ],
    );

    return form;
  }

  draw();
}
