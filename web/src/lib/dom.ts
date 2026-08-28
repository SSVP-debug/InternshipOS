// dom.ts — small, dependency-free DOM helpers. No framework: every page is
// a function that builds and returns a DOM subtree, matching a plain
// "render(container)" model that's easy to reason about without a build
// step beyond Vite/TS itself.

type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (typeof value === "boolean") {
      if (value) el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: HTMLElement) {
  el.innerHTML = "";
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function relativeDays(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

export function toast(message: string, tone: "success" | "error" = "success") {
  const el = h("div", { class: `toast toast--${tone}` }, [message]);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add("toast--visible"));
  setTimeout(() => {
    el.classList.remove("toast--visible");
    setTimeout(() => el.remove(), 200);
  }, 3200);
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const base = String((err as { message: unknown }).message);
    const fieldSummary = validationFieldSummary((err as { details?: unknown }).details);
    return fieldSummary ? `${base} — ${fieldSummary}` : base;
  }
  return "Something went wrong.";
}

// Backend validation failures (see api/src/lib/schemas.ts) return Zod's
// `.flatten()` shape as `details`: `{ formErrors: string[], fieldErrors:
// { [field]: string[] } }`. Without this, every validation failure surfaced
// to the user as the bare, unhelpful code (e.g. "invalid_request") with no
// indication of which field or value was rejected — this pulls the actual
// per-field reason out so the person filling in the form has something
// actionable. Defensive against any other shape (missing/malformed
// `details`, e.g. from a non-validation error) — returns null rather than
// throwing, so a display-helper bug can never break error rendering itself.
function validationFieldSummary(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object") return null;

  const parts: string[] = [];
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
    if (Array.isArray(messages) && messages.length > 0 && typeof messages[0] === "string") {
      parts.push(`${field}: ${messages[0]}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
