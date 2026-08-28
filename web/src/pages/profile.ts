import { h, toast, errorMessage } from "../lib/dom";
import { renderShell } from "../lib/shell";
import { renderCrudSection, type FieldConfig } from "../lib/crudSection";
import {
  WORK_AUTH_STATUS_OPTIONS,
  EDUCATION_DEGREE_TYPE_OPTIONS,
  EDUCATION_ENROLLMENT_STATUS_OPTIONS,
  SKILL_CATEGORY_OPTIONS,
  SKILL_SELF_RATING_OPTIONS,
} from "../lib/profileFieldOptions";
import {
  getProfile,
  saveProfile,
  grantConsent,
  getWorkAuthorization,
  saveWorkAuthorization,
  updateWorkAuthorization,
  educationApi,
  skillApi,
  projectApi,
  experienceApi,
  achievementApi,
  certificationApi,
  evidenceSourceApi,
  listClaims,
  createClaim,
  setClaimStatus,
  ApiError,
  type PersonalInfo,
  type WorkAuthorization,
  type Education,
  type Skill,
  type Project,
  type Experience,
  type Achievement,
  type Certification,
  type EvidenceSource,
  type Claim,
} from "../lib/api";

const TABS = [
  "Personal Info",
  "Work Authorization",
  "Education",
  "Skills",
  "Projects",
  "Experience",
  "Achievements",
  "Certifications",
  "Evidence Sources",
] as const;
type Tab = (typeof TABS)[number];

export async function renderProfile(root: HTMLElement) {
  const main = renderShell(root, "/profile");
  main.append(h("div", { class: "page-loading" }, ["Loading profile…"]));
  main.innerHTML = "";

  main.append(
    h("div", { class: "page-header" }, [
      h("div", {}, [
        h("h1", {}, ["Profile"]),
        h("p", { class: "subtle" }, ["Everything here backs the Truth Center — the more you fill in, the more InternshipOS can eventually help with applications."]),
      ]),
    ]),
  );

  let active: Tab = "Personal Info";
  const tabBar = h("div", { class: "tabs" }, []);
  const content = h("div", {}, []);

  function drawTabs() {
    tabBar.innerHTML = "";
    for (const tab of TABS) {
      tabBar.append(
        h(
          "button",
          {
            class: `tab ${active === tab ? "tab--active" : ""}`,
            onClick: () => {
              active = tab;
              drawTabs();
              drawContent();
            },
          },
          [tab],
        ),
      );
    }
  }

  function drawContent() {
    content.innerHTML = "";
    content.append(renderTab(active));
  }

  drawTabs();
  main.append(tabBar, content);
  drawContent();
}

function renderTab(tab: Tab): HTMLElement {
  switch (tab) {
    case "Personal Info":
      return renderPersonalInfoForm();
    case "Work Authorization":
      return renderWorkAuthorizationForm();
    case "Education":
      return renderEducationSection();
    case "Skills":
      return renderSkillsSection();
    case "Projects":
      return renderProjectsSection();
    case "Experience":
      return renderExperienceSection();
    case "Achievements":
      return renderAchievementsSection();
    case "Certifications":
      return renderCertificationsSection();
    case "Evidence Sources":
      return renderEvidenceSection();
  }
}

// ── Personal Info (singleton) ────────────────────────────────────────────

function renderPersonalInfoForm(): HTMLElement {
  const wrapper = h("div", { class: "card" }, [h("div", { class: "empty" }, ["Loading…"])]);

  getProfile()
    .then(({ personal_info }) => {
      wrapper.innerHTML = "";
      const fields: { key: keyof PersonalInfo; label: string; type: string; required?: boolean }[] = [
        { key: "legal_first_name", label: "Legal first name", type: "text", required: true },
        { key: "legal_last_name", label: "Legal last name", type: "text", required: true },
        { key: "preferred_name", label: "Preferred name", type: "text" },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "phone", label: "Phone", type: "tel" },
        { key: "location_city", label: "City", type: "text" },
        { key: "location_country", label: "Country", type: "text", required: true },
        { key: "pronouns", label: "Pronouns", type: "text" },
      ];
      const inputs = new Map<keyof PersonalInfo, HTMLInputElement>();
      const rows: HTMLElement[] = [];
      for (const f of fields) {
        const input = h("input", { type: f.type, required: f.required ?? false }) as HTMLInputElement;
        if (personal_info && personal_info[f.key]) input.value = String(personal_info[f.key]);
        inputs.set(f.key, input);
        rows.push(h("div", { class: "field" }, [h("label", {}, [f.label]), input]));
      }
      const grouped: HTMLElement[] = [];
      for (let i = 0; i < rows.length; i += 2) grouped.push(h("div", { class: "form-row" }, rows.slice(i, i + 2)));

      const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
      const saveBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Save"]);

      async function attemptSave(payload: PersonalInfo) {
        errorBox.innerHTML = "";
        errorBox.style.display = "none";
        saveBtn.setAttribute("disabled", "");
        try {
          await saveProfile(payload);
          toast("Personal info saved.");
        } catch (err) {
          if (err instanceof ApiError && err.code === "consent_required") {
            // Self-service recovery path: a candidate can reach this form
            // without ever having granted data_processing consent — most
            // commonly an existing candidate who already has personal_info
            // and so is never routed back through onboarding.ts's consent
            // checkbox (see renderOnboarding's early-redirect). Without
            // this, that candidate has NO way to grant consent from
            // anywhere in the app and every save silently 403s forever.
            errorBox.innerHTML = "";
            errorBox.append(
              h("span", {}, [
                "Saving your profile requires granting consent for InternshipOS to process your data. ",
              ]),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn--small",
                  onClick: async () => {
                    try {
                      await grantConsent("data_processing");
                      toast("Consent granted.");
                      await attemptSave(payload);
                    } catch (grantErr) {
                      errorBox.textContent = errorMessage(grantErr);
                      errorBox.style.display = "block";
                    }
                  },
                },
                ["Grant consent and save"],
              ),
            );
            errorBox.style.display = "block";
          } else {
            errorBox.textContent = errorMessage(err);
            errorBox.style.display = "block";
          }
        } finally {
          saveBtn.removeAttribute("disabled");
        }
      }

      const form = h(
        "form",
        {
          class: "form",
          onSubmit: async (e: Event) => {
            e.preventDefault();
            const payload = Object.fromEntries(
              Array.from(inputs.entries()).map(([k, el]) => [k, el.value || undefined]),
            ) as unknown as PersonalInfo;
            await attemptSave(payload);
          },
        },
        [...grouped, errorBox, saveBtn],
      );
      wrapper.append(form);
    })
    .catch((err) => {
      wrapper.innerHTML = "";
      wrapper.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    });

  return wrapper;
}

// ── Work Authorization (singleton) ───────────────────────────────────────

function renderWorkAuthorizationForm(): HTMLElement {
  const wrapper = h("div", { class: "card" }, [h("div", { class: "empty" }, ["Loading…"])]);

  getWorkAuthorization()
    .then(({ work_authorization }) => {
      wrapper.innerHTML = "";
      const isExisting = work_authorization !== null;

      const citizenship = h("input", { type: "text", required: true }) as HTMLInputElement;
      const status = h("select", { required: true }, [
        h("option", { value: "" }, ["Select status…"]),
        ...WORK_AUTH_STATUS_OPTIONS.map(([v, l]) => h("option", { value: v }, [l])),
      ]) as HTMLSelectElement;
      const requiresSponsorship = h("input", { type: "checkbox" }) as HTMLInputElement;
      const expiry = h("input", { type: "date" }) as HTMLInputElement;
      const notes = h("textarea", {}) as HTMLTextAreaElement;

      if (work_authorization) {
        citizenship.value = work_authorization.citizenship_country;
        status.value = work_authorization.status;
        requiresSponsorship.checked = work_authorization.requires_sponsorship;
        if (work_authorization.work_auth_expiry_date) expiry.value = work_authorization.work_auth_expiry_date;
        if (work_authorization.notes) notes.value = work_authorization.notes;
      }

      const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
      const saveBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Save"]);

      const form = h(
        "form",
        {
          class: "form",
          onSubmit: async (e: Event) => {
            e.preventDefault();
            errorBox.style.display = "none";
            saveBtn.setAttribute("disabled", "");
            const payload: WorkAuthorization = {
              citizenship_country: citizenship.value,
              status: status.value,
              requires_sponsorship: requiresSponsorship.checked,
              work_auth_expiry_date: expiry.value || undefined,
              notes: notes.value || undefined,
            };
            try {
              if (isExisting) await updateWorkAuthorization(payload);
              else await saveWorkAuthorization(payload);
              toast("Work authorization saved.");
            } catch (err) {
              errorBox.textContent = errorMessage(err);
              errorBox.style.display = "block";
            } finally {
              saveBtn.removeAttribute("disabled");
            }
          },
        },
        [
          h("div", { class: "form-row" }, [
            h("div", { class: "field" }, [h("label", {}, ["Citizenship country"]), citizenship]),
            h("div", { class: "field" }, [h("label", {}, ["Status"]), status]),
          ]),
          h("div", { class: "form-row" }, [
            h("div", { class: "field field--checkbox" }, [requiresSponsorship, h("label", {}, ["Requires sponsorship"])]),
            h("div", { class: "field" }, [h("label", {}, ["Work auth expiry (if applicable)"]), expiry]),
          ]),
          h("div", { class: "field" }, [h("label", {}, ["Notes"]), notes]),
          errorBox,
          saveBtn,
        ],
      );
      wrapper.append(form);
    })
    .catch((err) => {
      wrapper.innerHTML = "";
      wrapper.append(h("div", { class: "form-error" }, [errorMessage(err)]));
    });

  return wrapper;
}

// ── Claims widget — reusable across every claim-bearing entity ──────────

function renderClaimsWidget(subjectType: string, subjectId: string): HTMLElement {
  const wrapper = h("div", { style: "margin-top:12px;padding-top:12px;border-top:1px solid var(--line)" }, [
    h("div", { class: "empty" }, ["Loading claims…"]),
  ]);

  async function load() {
    wrapper.innerHTML = "";
    let claims: Claim[];
    try {
      const all = await listClaims();
      claims = all.filter((c) => c.subject_entity_type === subjectType && c.subject_entity_id === subjectId);
    } catch {
      wrapper.append(h("div", { class: "subtle" }, ["Couldn't load claims."]));
      return;
    }

    wrapper.append(h("div", { class: "subtle", style: "font-weight:600;margin-bottom:6px" }, ["Claims"]));

    if (claims.length === 0) {
      wrapper.append(h("div", { class: "subtle" }, ["No claims yet."]));
    }

    for (const claim of claims) {
      const canConfirm = claim.status === "DRAFT" || claim.status === "DISPUTED";
      const canDispute = claim.status === "DRAFT" || claim.status === "CONFIRMED";
      const canRevoke = claim.status !== "REVOKED";
      wrapper.append(
        h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap" }, [
          h("span", { class: `pill pill--${claim.status.toLowerCase()}` }, [claim.status]),
          h("span", { style: "flex:1;min-width:120px" }, [claim.claim_text]),
          canConfirm
            ? h(
                "button",
                {
                  class: "btn btn--small",
                  onClick: async () => {
                    try {
                      await setClaimStatus(claim.id, "CONFIRMED");
                      toast("Claim confirmed.");
                      await load();
                    } catch (err) {
                      toast(errorMessage(err), "error");
                    }
                  },
                },
                ["Confirm"],
              )
            : null,
          canDispute
            ? h(
                "button",
                {
                  class: "btn btn--small",
                  onClick: async () => {
                    try {
                      await setClaimStatus(claim.id, "DISPUTED");
                      toast("Claim disputed.");
                      await load();
                    } catch (err) {
                      toast(errorMessage(err), "error");
                    }
                  },
                },
                ["Dispute"],
              )
            : null,
          canRevoke
            ? h(
                "button",
                {
                  class: "btn btn--small btn--danger",
                  onClick: async () => {
                    if (!confirm("Revoke this claim? This can't be undone.")) return;
                    try {
                      await setClaimStatus(claim.id, "REVOKED");
                      toast("Claim revoked.");
                      await load();
                    } catch (err) {
                      toast(errorMessage(err), "error");
                    }
                  },
                },
                ["Revoke"],
              )
            : null,
        ]),
      );
    }

    const newClaimText = h("input", { type: "text", placeholder: "Claim text, e.g. 'Proficient in React'" }) as HTMLInputElement;
    const addBtn = h(
      "button",
      {
        class: "btn btn--small",
        onClick: async () => {
          const text = newClaimText.value.trim();
          if (!text) return;
          try {
            await createClaim({ subject_entity_type: subjectType, subject_entity_id: subjectId, claim_text: text });
            newClaimText.value = "";
            toast("Claim added as draft.");
            await load();
          } catch (err) {
            toast(errorMessage(err), "error");
          }
        },
      },
      ["Add claim"],
    );
    wrapper.append(h("div", { style: "display:flex;gap:6px;margin-top:6px" }, [newClaimText, addBtn]));
  }

  load();
  return wrapper;
}

// ── Repeating entity sections (via the generic CRUD builder) ────────────

function renderEducationSection(): HTMLElement {
  const fields: FieldConfig<Education>[] = [
    { key: "institution_name", label: "Institution", type: "text", required: true },
    { key: "institution_country", label: "Country", type: "text", required: true },
    { key: "degree_type", label: "Degree type", type: "select", required: true, options: EDUCATION_DEGREE_TYPE_OPTIONS },
    { key: "major", label: "Major", type: "text", required: true },
    { key: "minor", label: "Minor", type: "text" },
    { key: "start_date", label: "Start date", type: "date", required: true },
    { key: "expected_graduation_date", label: "Expected graduation", type: "date" },
    { key: "actual_graduation_date", label: "Actual graduation", type: "date" },
    {
      key: "enrollment_status",
      label: "Enrollment status",
      type: "select",
      required: true,
      options: EDUCATION_ENROLLMENT_STATUS_OPTIONS,
    },
    { key: "is_primary", label: "This is my primary education", type: "checkbox" },
  ];
  return renderCrudSection<Education>({
    title: "Education",
    fields,
    titleOf: (e) => `${e.degree_type} in ${e.major}`,
    subtitleOf: (e) => `${e.institution_name} · ${e.enrollment_status}`,
    api: educationApi,
    emptyLabel: "No education added yet.",
    renderExtra: (e) => renderClaimsWidget("education", e.id),
  });
}

function renderSkillsSection(): HTMLElement {
  const fields: FieldConfig<Skill>[] = [
    { key: "name", label: "Skill", type: "text", required: true },
    {
      key: "category",
      label: "Category",
      type: "select",
      required: true,
      options: SKILL_CATEGORY_OPTIONS,
    },
    {
      key: "self_rating",
      label: "Self rating",
      type: "select",
      options: SKILL_SELF_RATING_OPTIONS,
    },
  ];
  return renderCrudSection<Skill>({
    title: "Skills",
    fields,
    titleOf: (s) => s.name,
    subtitleOf: (s) => `${s.category}${s.self_rating ? ` · ${s.self_rating}` : ""}`,
    api: skillApi,
    emptyLabel: "No skills added yet.",
    renderExtra: (s) => renderClaimsWidget("skill", s.id),
  });
}

function renderProjectsSection(): HTMLElement {
  const fields: FieldConfig<Project>[] = [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "role", label: "Your role", type: "text" },
    { key: "team_size", label: "Team size", type: "number" },
    { key: "start_date", label: "Start date", type: "date" },
    { key: "end_date", label: "End date", type: "date" },
    { key: "is_ongoing", label: "Ongoing", type: "checkbox" },
    { key: "tech_stack", label: "Tech stack", type: "tags", placeholder: "React, Node.js, PostgreSQL" },
    { key: "external_url", label: "Link", type: "text" },
    { key: "description", label: "Description", type: "textarea", required: true },
  ];
  return renderCrudSection<Project>({
    title: "Projects",
    fields,
    titleOf: (p) => p.title,
    subtitleOf: (p) => (p.tech_stack ?? []).join(", "),
    api: projectApi,
    emptyLabel: "No projects added yet.",
    renderExtra: (p) => renderClaimsWidget("project", p.id),
  });
}

function renderExperienceSection(): HTMLElement {
  const fields: FieldConfig<Experience>[] = [
    { key: "organization", label: "Organization", type: "text", required: true },
    { key: "title", label: "Title", type: "text", required: true },
    {
      key: "employment_type",
      label: "Employment type",
      type: "select",
      required: true,
      options: [
        ["internship", "Internship"],
        ["part_time", "Part-time"],
        ["full_time", "Full-time"],
        ["volunteer", "Volunteer"],
        ["research", "Research"],
      ],
    },
    { key: "start_date", label: "Start date", type: "date", required: true },
    { key: "end_date", label: "End date", type: "date" },
    { key: "is_current", label: "I currently work here", type: "checkbox" },
    { key: "location", label: "Location", type: "text" },
    { key: "description_raw", label: "Description", type: "textarea", required: true },
  ];
  return renderCrudSection<Experience>({
    title: "Experience",
    fields,
    titleOf: (e) => `${e.title} at ${e.organization}`,
    subtitleOf: (e) => e.employment_type,
    api: experienceApi,
    emptyLabel: "No experience added yet.",
    renderExtra: (e) => renderClaimsWidget("experience", e.id),
  });
}

function renderAchievementsSection(): HTMLElement {
  const fields: FieldConfig<Achievement>[] = [
    { key: "title", label: "Title", type: "text", required: true },
    { key: "issuing_body", label: "Issuing body", type: "text" },
    { key: "date_awarded", label: "Date awarded", type: "date", required: true },
    { key: "rank_or_result", label: "Rank / result", type: "text" },
    { key: "verification_url", label: "Verification link", type: "text" },
  ];
  return renderCrudSection<Achievement>({
    title: "Achievements",
    fields,
    titleOf: (a) => a.title,
    subtitleOf: (a) => a.issuing_body ?? "",
    api: achievementApi,
    emptyLabel: "No achievements added yet.",
    renderExtra: (a) => renderClaimsWidget("achievement", a.id),
  });
}

function renderCertificationsSection(): HTMLElement {
  const fields: FieldConfig<Certification>[] = [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "issuer", label: "Issuer", type: "text", required: true },
    { key: "issue_date", label: "Issue date", type: "date", required: true },
    { key: "expiry_date", label: "Expiry date", type: "date" },
    { key: "credential_id", label: "Credential ID", type: "text" },
    { key: "verification_url", label: "Verification link", type: "text" },
  ];
  return renderCrudSection<Certification>({
    title: "Certifications",
    fields,
    titleOf: (c) => c.name,
    subtitleOf: (c) => c.issuer,
    api: certificationApi,
    emptyLabel: "No certifications added yet.",
    renderExtra: (c) => renderClaimsWidget("certification", c.id),
  });
}

function renderEvidenceSection(): HTMLElement {
  const fields: FieldConfig<EvidenceSource>[] = [
    {
      key: "source_type",
      label: "Source type",
      type: "select",
      required: true,
      options: [
        ["document_upload", "Document upload"],
        ["github_repository", "GitHub repository"],
      ],
    },
    { key: "title", label: "Title", type: "text", required: true },
    { key: "external_url", label: "URL (for GitHub repos)", type: "text" },
    { key: "file_ref", label: "File reference (for uploads)", type: "text" },
  ];
  return renderCrudSection<EvidenceSource>({
    title: "Evidence Sources",
    description: "Documents and repositories that back up your claims. Attach a claim above to one of these once it exists.",
    fields,
    titleOf: (e) => e.title,
    subtitleOf: (e) => (e.source_type === "github_repository" ? "GitHub repository" : "Document upload"),
    api: evidenceSourceApi,
    emptyLabel: "No evidence sources added yet.",
  });
}
