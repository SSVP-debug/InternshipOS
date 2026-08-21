import { h, clear, errorMessage } from "../lib/dom";
import { grantConsent, saveProfile, getProfile, ApiError, type PersonalInfo } from "../lib/api";
import { navigate } from "../lib/router";

export async function renderOnboarding(root: HTMLElement) {
  clear(root);

  let consentGranted = false;
  try {
    const { personal_info } = await getProfile();
    if (personal_info) {
      // Already onboarded — skip straight to the dashboard.
      navigate("/today");
      return;
    }
  } catch {
    // candidate_not_found or similar — fine, proceed with onboarding.
  }

  const errorBox = h("div", { class: "form-error", style: "display:none" }, []);

  const firstName = h("input", { type: "text", required: true });
  const lastName = h("input", { type: "text", required: true });
  const email = h("input", { type: "email", required: true });
  const country = h("input", { type: "text", required: true, placeholder: "e.g. United States" });
  const city = h("input", { type: "text" });

  const consentCheckbox = h("input", { type: "checkbox", id: "consent-checkbox" }) as HTMLInputElement;

  const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Get started"]);

  const form = h(
    "form",
    {
      class: "form",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        errorBox.style.display = "none";
        if (!consentCheckbox.checked) {
          errorBox.textContent = "You need to agree to data processing before InternshipOS can store your profile.";
          errorBox.style.display = "block";
          return;
        }
        submitBtn.setAttribute("disabled", "");
        submitBtn.textContent = "Setting up…";
        try {
          if (!consentGranted) {
            await grantConsent("data_processing");
            consentGranted = true;
          }
          const data: PersonalInfo = {
            legal_first_name: (firstName as HTMLInputElement).value,
            legal_last_name: (lastName as HTMLInputElement).value,
            email: (email as HTMLInputElement).value,
            location_country: (country as HTMLInputElement).value,
            location_city: (city as HTMLInputElement).value || undefined,
          };
          await saveProfile(data);
          navigate("/today");
        } catch (err) {
          errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
          errorBox.style.display = "block";
        } finally {
          submitBtn.removeAttribute("disabled");
          submitBtn.textContent = "Get started";
        }
      },
    },
    [
      h("div", { class: "form-row" }, [
        h("div", { class: "field" }, [h("label", {}, ["Legal first name"]), firstName]),
        h("div", { class: "field" }, [h("label", {}, ["Legal last name"]), lastName]),
      ]),
      h("div", { class: "field" }, [h("label", {}, ["Email"]), email]),
      h("div", { class: "form-row" }, [
        h("div", { class: "field" }, [h("label", {}, ["Country"]), country]),
        h("div", { class: "field" }, [h("label", {}, ["City (optional)"]), city]),
      ]),
      h("div", { class: "field field--checkbox" }, [
        consentCheckbox,
        h("label", { for: "consent-checkbox" }, [
          "I agree to InternshipOS processing my data to build and manage my candidate profile.",
        ]),
      ]),
      errorBox,
      submitBtn,
    ],
  );

  root.append(
    h("div", { class: "centered-page" }, [
      h("div", { class: "auth-card", style: "width:460px" }, [
        h("h1", {}, ["Set up your profile"]),
        h("p", { class: "subtle" }, [
          "A few basics so InternshipOS knows who you are. You can fill in education, skills, and experience anytime from your Profile page.",
        ]),
        h("div", { style: "height:16px" }, []),
        form,
      ]),
    ]),
  );
}
