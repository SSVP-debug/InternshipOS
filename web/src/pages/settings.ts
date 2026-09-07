import { h, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  listConsents,
  grantConsent,
  exportAccount,
  deleteAccount,
  getProfile,
  updateProfileStatus,
  type ConsentRecord,
  type ConsentType,
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
// moment you grant it. Treating this one identically — a clickable
// "Grant" that flips to a "Granted" pill — told candidates GitHub access
// was live when clicking it does nothing but write a consent_record row.
// This note (and the disabled state below) is the fix: still collectible
// as a future pre-authorization, but never presented as an active
// connection.
const CONSENT_NOT_YET_AVAILABLE: Partial<Record<ConsentType, string>> = {
  github_oauth_access:
    "GitHub sync isn't built yet — this only pre-authorizes it for later. Granting it does not connect a GitHub account or read any repos.",
};

export async function renderSettings(root: HTMLElement) {
  const main = renderShell(root, "/settings");
  main.append(h("div", { class: "page-loading" }, ["Loading settings…"]));
  main.innerHTML = "";

  main.append(h("div", { class: "page-header" }, [h("h1", {}, ["Settings"])]));

  main.append(h("h2", { class: "section-title" }, ["Consent"]));
  const consentCard = h("div", { class: "card" }, [h("div", { class: "empty" }, ["Loading…"])]);
  main.append(consentCard);

  async function loadConsents() {
    consentCard.innerHTML = "";
    let consents: ConsentRecord[];
    try {
      consents = await listConsents();
    } catch (err) {
      consentCard.append(h("div", { class: "form-error" }, [errorMessage(err)]));
      return;
    }

    const byType = new Map(consents.map((c) => [c.consent_type, c]));
    (Object.keys(CONSENT_LABELS) as ConsentType[]).forEach((type, i) => {
      const record = byType.get(type);
      const granted = record && !record.revoked_at;
      const notYetAvailableNote = CONSENT_NOT_YET_AVAILABLE[type];

      const metaText = granted ? `Granted ${new Date(record!.granted_at).toLocaleDateString()}` : "Not granted";

      let action: HTMLElement;
      if (granted) {
        // Already granted (possibly from before this note existed) —
        // still shown as Granted, since it's a true statement about the
        // consent_record; the note above is what clarifies it doesn't
        // do anything live yet.
        action = h("span", { class: "pill pill--confirmed" }, ["Granted"]);
      } else if (notYetAvailableNote) {
        action = h("span", { class: "pill", title: notYetAvailableNote }, ["Coming soon"]);
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
            h("div", { class: "list-row__meta" }, [metaText]),
            notYetAvailableNote ? h("div", { class: "list-row__meta" }, [notYetAvailableNote]) : null,
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
          h("div", { class: "subtle" }, ["Download every record InternshipOS has about you as JSON."]),
        ]),
        h(
          "button",
          {
            class: "btn",
            onClick: async () => {
              try {
                const data = await exportAccount();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = h("a", { href: url, download: "internshipos-export.json" }, []);
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
