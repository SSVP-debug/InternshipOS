import { h, formatDate, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import {
  getApplication,
  updateApplication,
  setApplicationStatus,
  addApplicationNote,
  updateApplicationNote,
  deleteApplicationNote,
  submitApplicationToAts,
  ApiError,
  type Application,
  type ApplicationStatus,
  type ApplicationStatusEvent,
  type ApplicationNote,
  type AtsSubmitDryRunResult,
} from "../lib/api";

const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  SAVED: ["APPLYING", "WITHDRAWN"],
  APPLYING: ["APPLIED", "WITHDRAWN"],
  APPLIED: ["ASSESSMENT", "INTERVIEW", "REJECTED", "WITHDRAWN"],
  ASSESSMENT: ["INTERVIEW", "REJECTED", "WITHDRAWN"],
  INTERVIEW: ["OFFER", "REJECTED", "WITHDRAWN"],
  OFFER: [],
  REJECTED: [],
  WITHDRAWN: [],
};

const NOTE_TYPE_LABEL: Record<ApplicationNote["note_type"], string> = {
  general: "Note",
  recruiter_contact: "Recruiter contact",
  interview: "Interview notes",
  next_action: "Next action",
  link: "Link",
};

export async function renderApplicationDetail(root: HTMLElement, applicationId: string) {
  const main = renderShell(root, "/applications");
  main.append(h("div", { class: "page-loading" }, ["Loading application…"]));

  let application: Application;
  let history: ApplicationStatusEvent[];
  let notes: ApplicationNote[];
  try {
    const result = await getApplication(applicationId);
    application = result.application;
    history = result.status_history;
    notes = result.notes;
  } catch (err) {
    main.innerHTML = "";
    main.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    return;
  }

  function draw() {
    main.innerHTML = "";

    main.append(
      h("div", { class: "page-header" }, [
        h("div", {}, [
          h("a", { href: "#/applications", class: "subtle" }, ["← All applications"]),
          h("h1", { style: "margin-top:6px" }, [application.opportunity?.title ?? "(opportunity removed)"]),
          h("div", { class: "subtle" }, [application.opportunity?.company ?? ""]),
        ]),
        h("span", { class: `pill pill--${application.status.toLowerCase()}` }, [application.status]),
      ]),
    );

    main.append(renderTransitionBar());
    main.append(renderOpportunityCard());
    main.append(renderAtsSection());
    main.append(h("h2", { class: "section-title" }, ["Tracking details"]));
    main.append(renderEditForm());
    main.append(h("h2", { class: "section-title" }, ["Notes"]));
    main.append(renderNotesSection());
    main.append(h("h2", { class: "section-title" }, ["Status history"]));
    main.append(renderHistory());
  }

  function renderTransitionBar(): HTMLElement {
    const options = TRANSITIONS[application.status];
    if (options.length === 0) {
      return h("div", { class: "subtle", style: "margin-bottom:20px" }, [`${application.status} is a final status — nothing else to do here.`]);
    }
    return h(
      "div",
      { class: "btn-row", style: "margin-bottom:20px" },
      options.map((status) =>
        h(
          "button",
          {
            class: `btn ${status === "WITHDRAWN" || status === "REJECTED" ? "btn--danger" : "btn--primary"}`,
            onClick: () => transitionTo(status),
          },
          [`Mark as ${status}`],
        ),
      ),
    );
  }

  async function transitionTo(status: ApplicationStatus) {
    let note: string | undefined;
    if (status === "WITHDRAWN" || status === "REJECTED") {
      const entered = prompt(`Add a note about this ${status === "WITHDRAWN" ? "withdrawal" : "rejection"}? (optional)`);
      note = entered?.trim() || undefined;
    }
    try {
      application = await setApplicationStatus(application.id, status, note);
      const result = await getApplication(application.id);
      history = result.status_history;
      toast(`Marked as ${status}.`);
      draw();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  const ATS_ERROR_MESSAGES: Record<string, string> = {
    external_ats_submission_disabled: "Auto-submit isn't enabled on this server yet.",
    unsupported_ats: "This posting isn't hosted on Lever — auto-submit currently only supports Lever-hosted postings.",
    resume_missing_file: "The resume attached to this application has no uploaded file — attach a document to it under Resumes first.",
    no_resume_selected: "This application has no resume selected — pick one under Tracking details first.",
    personal_info_incomplete: "Your legal name and email need to be filled in under Profile before auto-submitting.",
    opportunity_closed: "This posting is no longer open on Lever.",
    opportunity_missing_application_url: "This opportunity has no application link on file.",
    application_not_eligible_for_submission: "This application has already moved past SAVED/APPLYING — auto-submit only applies before that.",
    ats_posting_unavailable: "Couldn't reach Lever to confirm this posting is still live.",
    resume_file_unavailable: "Couldn't retrieve the resume file to attach.",
    resume_file_download_failed: "Couldn't download the resume file to attach.",
    ats_submission_failed: "Lever rejected the submission",
  };

  function renderAtsSection(): HTMLElement {
    const eligible = application.status === "SAVED" || application.status === "APPLYING";
    const alreadySubmitted = Boolean(application.ats_submitted_at);
    if (!eligible && !alreadySubmitted) return h("div", {}, []);

    const body = h("div", {}, []);

    if (alreadySubmitted) {
      body.append(
        h("div", { class: "list-row__meta" }, [
          `Submitted via ${application.ats_provider ?? "an external ATS"} on ${formatDate(application.ats_submitted_at!)}.`,
        ]),
      );
    }
    if (!eligible) {
      return h("div", { class: "card" }, [body]);
    }

    if (application.ats_submission_error) {
      body.append(h("div", { class: "form-error" }, [`Last attempt failed: ${application.ats_submission_error}`]));
    }

    const previewArea = h("div", { style: "margin-top:10px" }, []);

    const previewBtn = h(
      "button",
      {
        class: "btn btn--small",
        onClick: async () => {
          previewBtn.setAttribute("disabled", "");
          previewArea.innerHTML = "";
          previewArea.append(h("div", { class: "subtle" }, ["Checking the posting on Lever…"]));
          const result = await submitApplicationToAts(application.id, { dry_run: true });
          previewBtn.removeAttribute("disabled");
          previewArea.innerHTML = "";
          if (!result.ok) {
            previewArea.append(h("div", { class: "form-error" }, [ATS_ERROR_MESSAGES[result.error] ?? result.message ?? result.error]));
            return;
          }
          if (!result.dry_run) {
            // Can't actually happen (this call always passes dry_run: true),
            // but keeps the branch exhaustive for the type checker.
            return;
          }
          previewArea.append(renderDryRunPreview(result.would_submit));
        },
      },
      ["Preview auto-submit"],
    );

    body.append(
      h("div", {}, [
        h("div", { class: "subtle", style: "margin-bottom:8px" }, [
          "Auto-submit this application through the employer's ATS, where supported (currently: Lever-hosted postings only, base fields only — no custom screening questions).",
        ]),
        h("div", { class: "btn-row" }, [previewBtn]),
        previewArea,
      ]),
    );

    return h("div", { class: "card" }, [body]);
  }

  function renderDryRunPreview(wouldSubmit: AtsSubmitDryRunResult["would_submit"]): HTMLElement {
    const submitBtn = h(
      "button",
      {
        class: "btn btn--primary btn--small",
        onClick: async () => {
          if (!confirm(`Submit this application to "${wouldSubmit.posting_title}" on Lever now? This sends a real application to the employer and can't be undone.`)) {
            return;
          }
          submitBtn.setAttribute("disabled", "");
          try {
            const result = await submitApplicationToAts(application.id, { dry_run: false });
            if (!result.ok) {
              toast(ATS_ERROR_MESSAGES[result.error] ?? result.message ?? result.error, "error");
              submitBtn.removeAttribute("disabled");
              return;
            }
            if (result.dry_run) {
              // Can't actually happen (this call always passes dry_run: false),
              // but keeps the branch exhaustive for the type checker.
              submitBtn.removeAttribute("disabled");
              return;
            }
            application = result.application;
            const historyResult = await getApplication(application.id);
            history = historyResult.status_history;
            toast("Submitted to Lever.");
            draw();
          } catch (err) {
            toast(errorMessage(err), "error");
            submitBtn.removeAttribute("disabled");
          }
        },
      },
      ["Submit for real"],
    );

    return h("div", { class: "card", style: "background:var(--surface-2,#f7f7f7)" }, [
      h("div", { style: "margin-bottom:6px" }, [`Would submit to: ${wouldSubmit.posting_title} (Lever)`]),
      h("div", { class: "list-row__meta" }, [
        [`Name: ${wouldSubmit.name}`, `Email: ${wouldSubmit.email}`, wouldSubmit.phone ? `Phone: ${wouldSubmit.phone}` : null, `Resume: ${wouldSubmit.resume_title}`]
          .filter(Boolean)
          .join(" · "),
      ]),
      h("div", { class: "btn-row", style: "margin-top:10px" }, [submitBtn]),
    ]);
  }

  function renderOpportunityCard(): HTMLElement {
    const o = application.opportunity;
    if (!o) return h("div", {}, []);
    return h("div", { class: "card" }, [
      h("div", { class: "list-row__meta" }, [
        [o.location, o.work_mode, o.deadline_date ? `Deadline ${formatDate(o.deadline_date)}` : null]
          .filter(Boolean)
          .join(" · "),
      ]),
      o.application_url
        ? h("div", { class: "link-row" }, [
            h("a", { class: "btn btn--small", href: o.application_url, target: "_blank", rel: "noopener" }, ["Open original listing"]),
          ])
        : null,
    ]);
  }

  function renderEditForm(): HTMLElement {
    const nextActionDate = h("input", { type: "date", value: application.next_action_date ?? "" });
    const nextActionNote = h("input", { type: "text", value: application.next_action_note ?? "", placeholder: "e.g. Send thank-you email" });
    const deadlineOverride = h("input", { type: "date", value: application.deadline_override ?? "" });
    const recruiterName = h("input", { type: "text", value: application.recruiter_name ?? "" });
    const recruiterEmail = h("input", { type: "email", value: application.recruiter_email ?? "" });
    const saveBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Save details"]);
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);

    const form = h(
      "form",
      {
        class: "form",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          errorBox.style.display = "none";
          saveBtn.setAttribute("disabled", "");
          try {
            application = await updateApplication(application.id, {
              next_action_date: (nextActionDate as HTMLInputElement).value || undefined,
              next_action_note: (nextActionNote as HTMLInputElement).value || undefined,
              deadline_override: (deadlineOverride as HTMLInputElement).value || undefined,
              recruiter_name: (recruiterName as HTMLInputElement).value || undefined,
              recruiter_email: (recruiterEmail as HTMLInputElement).value || undefined,
            });
            toast("Details saved.");
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
          h("div", { class: "field" }, [h("label", {}, ["Next action date"]), nextActionDate]),
          h("div", { class: "field" }, [h("label", {}, ["Next action"]), nextActionNote]),
        ]),
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Your deadline override"]), deadlineOverride]),
        ]),
        h("div", { class: "form-row" }, [
          h("div", { class: "field" }, [h("label", {}, ["Recruiter name"]), recruiterName]),
          h("div", { class: "field" }, [h("label", {}, ["Recruiter email"]), recruiterEmail]),
        ]),
        errorBox,
        saveBtn,
      ],
    );

    return h("div", { class: "card" }, [form]);
  }

  function renderNotesSection(): HTMLElement {
    const wrapper = h("div", {}, []);

    const contentField = h("textarea", { placeholder: "What did the recruiter say? Paste a link. Jot a reminder." });
    const typeField = h(
      "select",
      {},
      (Object.keys(NOTE_TYPE_LABEL) as ApplicationNote["note_type"][]).map((t) => h("option", { value: t }, [NOTE_TYPE_LABEL[t]])),
    );
    const addBtn = h("button", { class: "btn btn--primary btn--small", type: "submit" }, ["Add note"]);
    const errorBox = h("div", { class: "form-error", style: "display:none" }, []);

    const addForm = h(
      "form",
      {
        class: "form",
        onSubmit: async (e: Event) => {
          e.preventDefault();
          const content = (contentField as HTMLTextAreaElement).value.trim();
          if (!content) return;
          errorBox.style.display = "none";
          try {
            const note = await addApplicationNote(application.id, {
              note_type: (typeField as HTMLSelectElement).value as ApplicationNote["note_type"],
              content,
            });
            notes = [note, ...notes];
            (contentField as HTMLTextAreaElement).value = "";
            draw();
          } catch (err) {
            errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
            errorBox.style.display = "block";
          }
        },
      },
      [
        h("div", { class: "form-row" }, [
          h("div", { class: "field", style: "flex:0 0 180px" }, [h("label", {}, ["Type"]), typeField]),
        ]),
        h("div", { class: "field" }, [contentField]),
        errorBox,
        addBtn,
      ],
    );

    wrapper.append(h("div", { class: "card" }, [addForm]));

    if (notes.length === 0) {
      wrapper.append(h("div", { class: "empty" }, ["No notes yet."]));
      return wrapper;
    }

    for (const note of notes) {
      wrapper.append(
        h("div", { class: "card" }, [
          h("div", { class: "spread" }, [
            h("span", { class: "pill pill--saved" }, [NOTE_TYPE_LABEL[note.note_type]]),
            h("span", { class: "subtle" }, [formatDate(note.created_at)]),
          ]),
          h("p", { style: "margin:10px 0" }, [note.content]),
          h("div", { class: "btn-row" }, [
            h(
              "button",
              {
                class: "btn btn--small",
                onClick: async () => {
                  const edited = prompt("Edit note:", note.content);
                  if (edited === null || edited.trim() === "") return;
                  try {
                    const updated = await updateApplicationNote(note.id, { content: edited.trim(), note_type: note.note_type });
                    notes = notes.map((n) => (n.id === note.id ? updated : n));
                    draw();
                  } catch (err) {
                    toast(errorMessage(err), "error");
                  }
                },
              },
              ["Edit"],
            ),
            h(
              "button",
              {
                class: "btn btn--small btn--danger",
                onClick: async () => {
                  if (!confirm("Delete this note?")) return;
                  try {
                    await deleteApplicationNote(note.id);
                    notes = notes.filter((n) => n.id !== note.id);
                    draw();
                  } catch (err) {
                    toast(errorMessage(err), "error");
                  }
                },
              },
              ["Delete"],
            ),
          ]),
        ]),
      );
    }

    return wrapper;
  }

  function renderHistory(): HTMLElement {
    if (history.length === 0) return h("div", { class: "empty" }, ["No history yet."]);
    const card = h("div", { class: "card" }, []);
    history.forEach((event, i) => {
      card.append(
        h("div", { class: "list-row", style: i === 0 ? "border-top:none" : undefined }, [
          h("div", { class: "list-row__main" }, [
            h("div", {}, [event.from_status ? `${event.from_status} → ${event.to_status}` : `Created as ${event.to_status}`]),
            event.note ? h("div", { class: "list-row__meta" }, [event.note]) : null,
          ]),
          h("span", { class: "subtle" }, [formatDate(event.created_at)]),
        ]),
      );
    });
    return card;
  }

  draw();
}
