import { h, clear, errorMessage } from "../lib/dom";
import { signIn } from "../lib/auth";
import { signup as signupRequest, ApiError } from "../lib/api";
import { navigate } from "../lib/router";

export function renderLogin(root: HTMLElement) {
  clear(root);

  let submitting = false;
  const errorBox = h("div", { class: "form-error", style: "display:none" }, []);

  const emailField = h("input", { type: "email", required: true, autocomplete: "email" });
  const passwordField = h("input", { type: "password", required: true, autocomplete: "current-password" });

  const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Sign in"]);

  const form = h(
    "form",
    {
      class: "form",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        if (submitting) return;
        submitting = true;
        submitBtn.setAttribute("disabled", "");
        submitBtn.textContent = "Signing in…";
        errorBox.style.display = "none";

        const { error } = await signIn((emailField as HTMLInputElement).value, (passwordField as HTMLInputElement).value);
        submitting = false;
        submitBtn.removeAttribute("disabled");
        submitBtn.textContent = "Sign in";

        if (error) {
          errorBox.textContent = error;
          errorBox.style.display = "block";
          return;
        }
        navigate("/today");
      },
    },
    [
      h("div", { class: "field" }, [h("label", {}, ["Email"]), emailField]),
      h("div", { class: "field" }, [h("label", {}, ["Password"]), passwordField]),
      errorBox,
      submitBtn,
    ],
  );

  root.append(
    h("div", { class: "centered-page" }, [
      h("div", { class: "auth-card" }, [
        h("h1", {}, ["Welcome back"]),
        h("p", { class: "subtle" }, ["Sign in to keep working your internship search."]),
        h("div", { style: "height:16px" }, []),
        form,
        h("p", { class: "subtle", style: "margin-top:16px" }, [
          "New here? ",
          h("a", { href: "#/signup" }, ["Create an account"]),
        ]),
      ]),
    ]),
  );
}

export function renderSignup(root: HTMLElement) {
  clear(root);

  let submitting = false;
  const errorBox = h("div", { class: "form-error", style: "display:none" }, []);
  const successBox = h("div", { class: "form-error", style: "display:none;background:var(--accent-confirmed-bg);color:var(--accent-confirmed)" }, []);

  const emailField = h("input", { type: "email", required: true, autocomplete: "email" });
  const passwordField = h("input", { type: "password", required: true, minlength: "8", autocomplete: "new-password" });

  const submitBtn = h("button", { class: "btn btn--primary", type: "submit" }, ["Create account"]);

  const form = h(
    "form",
    {
      class: "form",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        if (submitting) return;
        submitting = true;
        submitBtn.setAttribute("disabled", "");
        submitBtn.textContent = "Creating account…";
        errorBox.style.display = "none";
        successBox.style.display = "none";

        try {
          await signupRequest((emailField as HTMLInputElement).value, (passwordField as HTMLInputElement).value);
          successBox.textContent = "Account created. Signing you in…";
          successBox.style.display = "block";
          const { error } = await signIn(
            (emailField as HTMLInputElement).value,
            (passwordField as HTMLInputElement).value,
          );
          if (error) {
            successBox.style.display = "none";
            errorBox.textContent = `Account created, but sign-in failed: ${error}. Try signing in manually.`;
            errorBox.style.display = "block";
          } else {
            navigate("/onboarding");
          }
        } catch (err) {
          errorBox.textContent = err instanceof ApiError ? err.message : errorMessage(err);
          errorBox.style.display = "block";
        } finally {
          submitting = false;
          submitBtn.removeAttribute("disabled");
          submitBtn.textContent = "Create account";
        }
      },
    },
    [
      h("div", { class: "field" }, [h("label", {}, ["Email"]), emailField]),
      h("div", { class: "field" }, [
        h("label", {}, ["Password"]),
        passwordField,
        h("span", { class: "subtle" }, ["At least 8 characters."]),
      ]),
      errorBox,
      successBox,
      submitBtn,
    ],
  );

  root.append(
    h("div", { class: "centered-page" }, [
      h("div", { class: "auth-card" }, [
        h("h1", {}, ["Start your search"]),
        h("p", { class: "subtle" }, ["One place to discover, track, and follow up on every internship."]),
        h("div", { style: "height:16px" }, []),
        form,
        h("p", { class: "subtle", style: "margin-top:16px" }, [
          "Already have an account? ",
          h("a", { href: "#/login" }, ["Sign in"]),
        ]),
      ]),
    ]),
  );
}
