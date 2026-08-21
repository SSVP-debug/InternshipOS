// main.ts
// Route registration and the auth guard. Every route is registered up
// front; guarding happens inside each handler by checking getSession()'s
// result rather than via router middleware, since router.ts is
// deliberately minimal (see its header) and doesn't have a middleware
// concept — this keeps that file simple while still giving every
// authenticated page the same one-line guard.

import "./style.css";
import { route, notFound, startRouter, navigate } from "./lib/router";
import { initSession, getSession, onSessionChange } from "./lib/auth";
import { renderLogin, renderSignup } from "./pages/authPages";
import { renderOnboarding } from "./pages/onboarding";
import { renderToday } from "./pages/today";
import { renderOpportunities } from "./pages/opportunities";
import { renderApplications } from "./pages/applications";
import { renderApplicationDetail } from "./pages/applicationDetail";
import { renderTruthCenter } from "./pages/truthCenter";
import { renderProfile } from "./pages/profile";
import { renderSettings } from "./pages/settings";

function requireAuth(render: (root: HTMLElement, ...args: string[]) => void | Promise<void>) {
  return async (params: Record<string, string>, root: HTMLElement) => {
    if (!getSession()) {
      navigate("/login");
      return;
    }
    await render(root, ...Object.values(params));
  };
}

function requireGuest(render: (root: HTMLElement) => void | Promise<void>) {
  return async (_params: Record<string, string>, root: HTMLElement) => {
    if (getSession()) {
      navigate("/today");
      return;
    }
    await render(root);
  };
}

route("/login", requireGuest(renderLogin));
route("/signup", requireGuest(renderSignup));
route("/onboarding", requireAuth(renderOnboarding));
route("/today", requireAuth(renderToday));
route("/opportunities", requireAuth(renderOpportunities));
route("/applications", requireAuth(renderApplications));
route("/applications/:id", requireAuth((root, id) => renderApplicationDetail(root, id)));
route("/truth-center", requireAuth(renderTruthCenter));
route("/profile", requireAuth(renderProfile));
route("/settings", requireAuth(renderSettings));
route("/", (_params, root) => {
  navigate(getSession() ? "/today" : "/login");
  root.append(document.createTextNode(""));
});

notFound((_params, root) => {
  root.innerHTML = "";
  const message = document.createElement("div");
  message.className = "centered-page";
  message.innerHTML =
    '<div class="auth-card"><h1>Page not found</h1><p class="subtle">That page doesn\'t exist. <a href="#/today">Go to Today</a>.</p></div>';
  root.append(message);
});

async function bootstrap() {
  const appRoot = document.querySelector<HTMLDivElement>("#app")!;
  await initSession();

  // Re-render the current route whenever auth state changes (sign in/out
  // from any tab or page), so the router's own guards re-evaluate.
  onSessionChange(() => {
    const hash = window.location.hash;
    window.location.hash = "";
    window.location.hash = hash || "#/";
  });

  startRouter(appRoot);
}

bootstrap();
