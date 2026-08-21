// crudSection.ts
// A single generic "list + inline add/edit form" builder, driven by a
// small field-config array, used for every one of the Profile page's
// repeating entity types (education, skill, project, experience,
// achievement, certification, evidence source). These all share the same
// shape at the API layer (GET list / POST / PUT :id / DELETE :id — see
// api/src/routes/education.ts and its siblings), so one generic builder
// here avoids writing the same list/form/edit/delete wiring seven times.
// Anything entity-specific (claims, trust tiers) is layered on top by the
// caller via `renderExtra`, not baked into this generic builder.

import { h, toast, errorMessage } from "./dom";
import { ApiError, type CrudApi } from "./api";

export type FieldType = "text" | "textarea" | "date" | "number" | "checkbox" | "select" | "tags";

export interface FieldConfig<T> {
  key: keyof T;
  label: string;
  type: FieldType;
  options?: [string, string][]; // for select
  required?: boolean;
  placeholder?: string;
}

export interface CrudSectionConfig<T extends { id: string }> {
  title: string;
  description?: string;
  fields: FieldConfig<T>[];
  titleOf: (item: T) => string;
  subtitleOf: (item: T) => string;
  api: CrudApi<T>;
  emptyLabel: string;
  renderExtra?: (item: T, refresh: () => void) => HTMLElement | null;
}

function fieldValue(field: FieldConfig<never>, input: HTMLElement): unknown {
  if (field.type === "checkbox") return (input as HTMLInputElement).checked;
  if (field.type === "number") {
    const raw = (input as HTMLInputElement).value;
    return raw === "" ? undefined : Number(raw);
  }
  if (field.type === "tags") {
    const raw = (input as HTMLInputElement).value;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const raw = (input as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  return raw === "" ? undefined : raw;
}

function buildField<T>(field: FieldConfig<T>, existing: Partial<T> | null): HTMLElement {
  const current = existing ? existing[field.key] : undefined;

  let input: HTMLElement;
  if (field.type === "textarea") {
    input = h("textarea", { placeholder: field.placeholder ?? "" });
    if (current !== undefined) (input as HTMLTextAreaElement).value = String(current);
  } else if (field.type === "select") {
    input = h("select", {}, [
      h("option", { value: "" }, [field.required ? `Select ${field.label.toLowerCase()}…` : "—"]),
      ...(field.options ?? []).map(([v, label]) => h("option", { value: v }, [label])),
    ]);
    if (current !== undefined) (input as HTMLSelectElement).value = String(current);
  } else if (field.type === "checkbox") {
    input = h("input", { type: "checkbox" });
    if (current) (input as HTMLInputElement).checked = true;
  } else if (field.type === "tags") {
    input = h("input", { type: "text", placeholder: field.placeholder ?? "Comma-separated" });
    if (Array.isArray(current)) (input as HTMLInputElement).value = current.join(", ");
  } else {
    input = h("input", { type: field.type, placeholder: field.placeholder ?? "" });
    if (current !== undefined) (input as HTMLInputElement).value = String(current);
  }
  return input;
}

export function renderCrudSection<T extends { id: string }>(config: CrudSectionConfig<T>): HTMLElement {
  const container = h("div", {}, []);
  let items: T[] = [];
  let loaded = false;

  async function load() {
    try {
      items = await config.api.list();
    } catch (err) {
      toast(errorMessage(err), "error");
      items = [];
    }
    loaded = true;
    draw();
  }

  function buildForm(existing: T | null, onDone: () => void): HTMLElement {
    const inputs = new Map<keyof T, HTMLElement>();
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
    const submitBtn = h("button", { class: "btn btn--primary btn--small", type: "submit" }, [
      existing ? "Save changes" : "Add",
    ]);

    const rows: HTMLElement[] = [];
    for (const field of config.fields) {
      const input = buildField(field, existing);
      inputs.set(field.key, input);
      const wrapperClass = field.type === "checkbox" ? "field field--checkbox" : "field";
      const fieldEl = h(
        "div",
        { class: wrapperClass },
        field.type === "checkbox" ? [input, h("label", {}, [field.label])] : [h("label", {}, [field.label]), input],
      );
      rows.push(fieldEl);
    }

    // Group fields two-per-row for compactness, except textareas which get their own row.
    const grouped: HTMLElement[] = [];
    let buffer: HTMLElement[] = [];
    config.fields.forEach((field, i) => {
      if (field.type === "textarea") {
        if (buffer.length) {
          grouped.push(h("div", { class: "form-row" }, buffer));
          buffer = [];
        }
        grouped.push(rows[i]);
      } else {
        buffer.push(rows[i]);
        if (buffer.length === 2) {
          grouped.push(h("div", { class: "form-row" }, buffer));
          buffer = [];
        }
      }
    });
    if (buffer.length) grouped.push(h("div", { class: "form-row" }, buffer));

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          errorBox.style.display = "none";
          submitBtn.setAttribute("disabled", "");
          const payload: Record<string, unknown> = {};
          for (const field of config.fields) {
            payload[field.key as string] = fieldValue(field, inputs.get(field.key)!);
          }
          try {
            if (existing) {
              await config.api.update(existing.id, payload as Partial<T>);
              toast("Saved.");
            } else {
              await config.api.create(payload as Partial<T>);
              toast("Added.");
            }
            await load();
            onDone();
          } catch (err) {
            errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
            errorBox.style.display = "block";
          } finally {
            submitBtn.removeAttribute("disabled");
          }
        },
      },
      [...grouped, errorBox, h("div", { class: "btn-row" }, [submitBtn])],
    );

    return form;
  }

  function draw() {
    container.innerHTML = "";
    container.append(h("h2", { class: "section-title" }, [config.title]));
    if (config.description) {
      container.append(h("p", { class: "subtle", style: "margin-top:-8px;margin-bottom:12px" }, [config.description]));
    }

    if (!loaded) {
      container.append(h("div", { class: "empty" }, ["Loading…"]));
      return;
    }

    let addOpen = false;
    const addCardBody = h("div", { style: "display:none" }, []);
    const addLabel = `+ Add ${config.title.toLowerCase().replace(/s$/, "")}`;
    const addToggle = h(
      "button",
      {
        class: "btn btn--small",
        onClick: () => {
          addOpen = !addOpen;
          addCardBody.style.display = addOpen ? "block" : "none";
          addToggle.textContent = addOpen ? "Cancel" : addLabel;
          if (addOpen) {
            addCardBody.innerHTML = "";
            addCardBody.append(
              buildForm(null, () => {
                addOpen = false;
                addCardBody.style.display = "none";
                addToggle.textContent = addLabel;
              }),
            );
          }
        },
      },
      [addLabel],
    );
    container.append(h("div", { class: "card" }, [addToggle, addCardBody]));

    if (items.length === 0) {
      container.append(h("div", { class: "empty" }, [config.emptyLabel]));
      return;
    }

    for (const item of items) {
      let editing = false;
      const itemCard = h("div", { class: "card" }, []);

      function drawItem() {
        itemCard.innerHTML = "";
        if (editing) {
          itemCard.append(
            buildForm(item, () => {
              editing = false;
              drawItem();
            }),
          );
          return;
        }
        itemCard.append(
          h("div", { class: "spread" }, [
            h("div", {}, [
              h("div", { style: "font-weight:600" }, [config.titleOf(item)]),
              h("div", { class: "subtle" }, [config.subtitleOf(item)]),
            ]),
            h("div", { class: "btn-row" }, [
              h(
                "button",
                {
                  class: "btn btn--small",
                  onClick: () => {
                    editing = true;
                    drawItem();
                  },
                },
                ["Edit"],
              ),
              h(
                "button",
                {
                  class: "btn btn--small btn--danger",
                  onClick: async () => {
                    if (!confirm(`Remove "${config.titleOf(item)}"?`)) return;
                    try {
                      await config.api.remove(item.id);
                      toast("Removed.");
                      await load();
                    } catch (err) {
                      toast(errorMessage(err), "error");
                    }
                  },
                },
                ["Remove"],
              ),
            ]),
          ]),
        );
        const extra = config.renderExtra?.(item, () => load());
        if (extra) itemCard.append(extra);
      }

      drawItem();
      container.append(itemCard);
    }
  }

  draw();
  load();
  return container;
}
