import { h, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  listConsents,
  grantConsent,
  exportAccount,
  deleteAccount,
  getProfile,
  updateProfileStatus,
  evidenceSourceApi,
  ApiError,
  type ConsentRecord,
  type ConsentType,
  type EvidenceSource,
} from "../lib/api";
import { navigate } from "../lib/router";
import { signOut } from "../lib/auth";

const CONSENT_LABELS: Record<ConsentType, string> = {
  data_processing: "Data processing (required)",
  github_oauth_access: "GitHub access (for evidence sync)",
  llm_processing: "AI-assisted application content",
  document_upload_storage: "Document upload storage",
};

// github_oauth_access is the one consent type with no backend behind it
// yet — grep api/src/routes for requireConsent("github_oauth_access") and
// there isn't one, and no OAuth route/callback exists anywhere in this
// repo (0004_consent_record.sql's own comment reserves it for "a future
// GitHub import"). Every OTHER consent type here gates something real the
// moment you grant it.
//
// Stopgap ahead of building real OAuth (app registration, callback route,
// linked-identity storage, actual sync logic — all separate, larger
// work): let the candidate paste their GitHub URL by hand now. This is
// stored as an ordinary evidence_source row with source_type
// "github_repository" — the exact type 0015_evidence_source.sql already
// defines for this, with owner_verified defaulting to false because
// nothing here verifies ownership (that's still only settable by the
// real OAuth flow, per that migration's own comment). No new column, no
// new migration — this is the "additive to extend later" case that
// design already anticipated.
//
// A fixed title ("GitHub profile") is the convention used to find "the"
// placeholder row again on reload, distinguishing it from any per-project
// repository links a candidate adds separately via Profile > Evidence
// Sources (which use their own free-form titles). Saving a URL here also
// grants github_oauth_access — the URL itself, not a separate click, is
// the actual expression of intent — but the note below always stays
// visible so "Granted" is never confused with a live connection.
const GITHUB_PLACEHOLDER_TITLE = "GitHub profile";
const CONSENT_NOTE: Partial<Record<ConsentType, string>> = {
  github_oauth_access:
    "GitHub sync isn't built yet. Pasting your URL below only saves it for later — it does not connect your account, verify ownership, or read any repos.",
};
function isLikelyGithubUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/i.test(url.trim());
}

export async function renderSettings(root: HTMLElement) {
  const main = renderShell(root, "/settings");
  main.append(h("div", { class: "page-loading" }, ["Loading settings…"]));
  main.innerHTML = "";

  main.append(h("div", { class: "page-header" }, [h("h1", {}, ["Settings"])]));

  main.append(h("h2", { class: "section-title" }, ["Consent"]));
  const consentCard = h("div", { class: "card" }, [h("div", { class: "empty" }, ["Loading…"])]);
  main.append(consentCard);

  // Builds the small inline "paste your GitHub URL" form used in place of
  // a plain Grant button for github_oauth_access. Kept as its own
  // function since it needs its own error box, input, and submit
  // handling distinct from every other (single-button) consent row.
  function renderGithubUrlForm(existing: EvidenceSource | undefined, onSaved: () => void): HTMLElement {
    const urlField = h("input", {
      type: "text",
      placeholder: "https://github.com/your-username",
      value: existing?.external_url ?? "",
    }) as HTMLInputElement;
    const errorBox = h("span", { class: "form-error", style: "display:none" }, []);
    const saveBtn = h("button", { class: "btn btn--small", type: "submit" }, [existing ? "Update" : "Save"]);

    const form = h(
      "form",
      {
        class: "form-row",
        style: "align-items:flex-start;gap:8px;margin-top:6px",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          const url = urlField.value.trim();
          errorBox.style.display = "none";
          if (!isLikelyGithubUrl(url)) {
            errorBox.textContent = "Enter a GitHub profile URL, e.g. https://github.com/your-username";
            errorBox.style.display = "inline";
            return;
          }
          saveBtn.setAttribute("disabled", "");
          try {
            if (existing) {
              await evidenceSourceApi.update(existing.id, { external_url: url });
            } else {
              await evidenceSourceApi.create({
                source_type: "github_repository",
                title: GITHUB_PLACEHOLDER_TITLE,
                external_url: url,
              });
            }
            // Best-effort: the URL is the meaningful action here, so its
            // being saved is what "granting" this consent now represents.
            // A failure here shouldn't undo the save above or block the
            // candidate — worst case the pill under-reports for a moment
            // and they can hit Grant separately.
            await grantConsent("github_oauth_access").catch(() => {});
            toast(existing ? "GitHub URL updated." : "GitHub URL saved.");
            onSaved();
          } catch (err) {
            errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
            errorBox.style.display = "inline";
          } finally {
            saveBtn.removeAttribute("disabled");
          }
        },
      },
      [h("div", { class: "field", style: "flex:1;margin:0" }, [urlField, errorBox]), saveBtn],
    );

    return form;
  }

  async function loadConsents() {
    consentCard.innerHTML = "";
    let consents: ConsentRecord[];
    let evidenceSources: EvidenceSource[];
    try {
      [consents, evidenceSources] = await Promise.all([listConsents(), evidenceSourceApi.list()]);
    } catch (err) {
      consentCard.append(h("div", { class: "form-error" }, [errorMessage(err)]));
      return;
    }

    const byType = new Map(consents.map((c) => [c.consent_type, c]));
    const githubPlaceholder = evidenceSources.find(
      (e) => e.source_type === "github_repository" && e.title === GITHUB_PLACEHOLDER_TITLE,
    );

    (Object.keys(CONSENT_LABELS) as ConsentType[]).forEach((type, i) => {
      const record = byType.get(type);
      const granted = record && !record.revoked_at;
      const note = CONSENT_NOTE[type];
      const isGithub = type === "github_oauth_access";

      const metaText = granted ? `Granted ${new Date(record!.granted_at).toLocaleDateString()}` : "Not granted";
      const githubMetaText = githubPlaceholder
        ? `Saved ${new Date(githubPlaceholder.created_at).toLocaleDateString()}`
        : "Not saved";

      let action: HTMLElement | null;
      if (isGithub) {
        // No standalone Grant button for this one — saving the URL
        // below is what grants it (see renderGithubUrlForm). Show a
        // status pill only once something's actually been saved.
        action = githubPlaceholder ? h("span", { class: "pill pill--confirmed" }, ["Saved"]) : null;
      } else if (granted) {
        action = h("span", { class: "pill pill--confirmed" }, ["Granted"]);
      } else {
        action = h(
          "button",
          {
            class: "btn btn--small",
            onClick: async () => {
              try {
                await grantConsent(type);
                toast("Consent granted.");
                await loadConsents();
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            },
          },
          ["Grant"],
        );
      }

      consentCard.append(
        h("div", { class: "list-row", style: i === 0 ? "border-top:none" : undefined }, [
          h("div", { class: "list-row__main" }, [
            h("div", { class: "list-row__title" }, [CONSENT_LABELS[type]]),
            h("div", { class: "list-row__meta" }, [isGithub ? githubMetaText : metaText]),
            note ? h("div", { class: "list-row__meta" }, [note]) : null,
            isGithub ? renderGithubUrlForm(githubPlaceholder, () => loadConsents()) : null,
          ]),
          action,
        ]),
      );
    });
  }
  await loadConsents();

  main.append(h("h2", { class: "section-title" }, ["Matching"]));
  const matchingCard = h("div", { class: "card" }, [h("div", { class: "empty" }, ["Loading…"])]);
  main.append(matchingCard);

  async function loadMatchingStatus() {
    matchingCard.innerHTML = "";
    let profileStatus: string;
    try {
      ({
        candidate: { profile_status: profileStatus },
      } = await getProfile());
    } catch (err) {
      matchingCard.append(h("div", { class: "form-error" }, [errorMessage(err)]));
      return;
    }

    // 'archived' isn't reachable from any UI control yet (see
    // PausableProfileStatus in api.ts), so there's nothing this toggle
    // could correctly offer here — PATCH /profile/status would just 409.
    if (profileStatus === "archived") {
      matchingCard.append(h("div", { class: "empty" }, ["This profile is archived."]));
      return;
    }

    const isPaused = profileStatus === "paused";
    matchingCard.append(
      h("div", { class: "spread" }, [
        h("div", {}, [
          h("div", { style: "font-weight:600" }, [isPaused ? "Matching is paused" : "Matching is active"]),
          h("div", { class: "subtle" }, [
            isPaused
              ? "You won't receive new daily matches until you resume."
              : "You're receiving new daily matches based on your profile.",
          ]),
        ]),
        h(
          "button",
          {
            class: "btn btn--small",
            onClick: async () => {
              try {
                await updateProfileStatus(isPaused ? "active" : "paused");
                toast(isPaused ? "Matching resumed." : "Matching paused.");
                await loadMatchingStatus();
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            },
          },
          [isPaused ? "Resume matching" : "Pause matching"],
        ),
      ]),
    );
  }
  await loadMatchingStatus();

  main.append(h("h2", { class: "section-title" }, ["Your data"]));
  main.append(
    h("div", { class: "card" }, [
      h("div", { class: "spread" }, [
        h("div", {}, [
          h("div", { style: "font-weight:600" }, ["Export everything"]),
          h("div", { class: "subtle" }, ["Download every record InternshipOS has about you as a PDF."]),
        ]),
        h(
          "button",
          {
            class: "btn",
            onClick: async () => {
              try {
                const blob = await exportAccount();
                const url = URL.createObjectURL(blob);
                const a = h("a", { href: url, download: "internshipos-export.pdf" }, []);
                document.body.append(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                toast("Export downloaded.");
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            },
          },
          ["Download export"],
        ),
      ]),
    ]),
  );

  main.append(h("h2", { class: "section-title" }, ["Danger zone"]));
  main.append(
    h("div", { class: "card", style: "border-color:var(--accent-urgent)" }, [
      h("div", { class: "spread" }, [
        h("div", {}, [
          h("div", { style: "font-weight:600" }, ["Delete account"]),
          h("div", { class: "subtle" }, [
            "Permanently deletes your candidate profile, claims, opportunities, applications, and every other record. This cannot be undone.",
          ]),
        ]),
        h(
          "button",
          {
            class: "btn btn--danger",
            onClick: async () => {
              const confirmed = confirm(
                "This will permanently delete your InternshipOS account and everything in it. Type OK to confirm you understand this cannot be undone.",
              );
              if (!confirmed) return;
              const doubleCheck = prompt('This is permanent. Type "DELETE" to confirm.');
              if (doubleCheck !== "DELETE") return;
              try {
                await deleteAccount();
                await signOut();
                toast("Account deleted.");
                navigate("/signup");
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            },
          },
          ["Delete my account"],
        ),
      ]),
    ]),
  );
}
