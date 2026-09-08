// shell.ts — the sidebar shell wrapped around every authenticated page.
//
// Gate A1 (persistent navigation): this used to rebuild the entire
// sidebar from scratch on every renderShell() call, relying on
// router.ts's render() clearing the whole #app root first (see that
// file's old header comment — "the whole #app root is cleared per
// navigation"). Now that router.ts no longer does that pre-clear, this
// module owns the decision itself: if a shell is already mounted in the
// given root, REUSE it (the <aside class="sidebar"> node is never
// removed from the DOM, so it never disappears/flashes on navigation) —
// only the <nav> contents (active link + badges can differ per route)
// and the <main> content region are replaced. The <main> element itself
// is swapped out (not just its innerHTML cleared) rather than reused in
// place, deliberately: every existing page handler closes over the
// specific `main` node renderShell() returns to it and may still write
// into that reference after an async fetch resolves (e.g. today.ts's
// `main.innerHTML = ""; main.append(...)` inside a `.catch`/`try` that
// runs after `await getToday()`). Swapping in a brand-new <main> on every
// navigation preserves the existing (accidental but load-bearing) safety
// property that a slow, now-stale previous page's async callback writes
// into a detached node nobody sees, instead of stomping on whatever the
// next page already rendered into a *shared* main element. This avoids
// having to touch every page file to add manual "is this navigation
// still current?" checks, which would be well beyond this gate's scope.
//
// A shell is considered stale (and rebuilt from scratch) the moment its
// cached <aside> is no longer attached to the document — which happens
// automatically the moment any bare/guest page (login, signup,
// onboarding) calls its own clear(root), or the not-found handler does
// root.innerHTML = "". No explicit "tear down the shell" call is needed
// anywhere else in the app for this to stay correct.

import { clear, h } from "./dom";
import { getSession, signOut } from "./auth";
import { currentPath, navigate } from "./router";

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/today", label: "Today", icon: "☉" },
  { path: "/feed", label: "Feed", icon: "✦" },
  { path: "/opportunities", label: "Opportunities", icon: "◈" },
  { path: "/applications", label: "Applications", icon: "▤" },
  { path: "/resumes", label: "Resumes", icon: "▧" },
  { path: "/truth-center", label: "Truth Center", icon: "✓" },
  { path: "/profile", label: "Profile", icon: "◎" },
  { path: "/settings", label: "Settings", icon: "⚙" },
];

// Module-level cache of the currently-mounted shell, if any. Deliberately
// simple module state (matching this codebase's existing "no framework,
// just DOM helpers" philosophy in dom.ts) rather than a class or a new
// abstraction — there is only ever one shell mounted in one root at a
// time in this single-page app.
let cachedRoot: HTMLElement | null = null;
let shellEl: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;
let navEl: HTMLElement | null = null;
let userLabelEl: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;

function buildNav(activePath: string, badges: Partial<Record<string, number>>): HTMLElement {
  return h(
    "nav",
    { class: "nav" },
    NAV_ITEMS.map((item) => {
      const isActive = activePath === item.path || currentPath().startsWith(item.path);
      const badgeCount = badges[item.path];
      return h(
        "a",
        {
          href: `#${item.path}`,
          class: `nav__link${isActive ? " nav__link--active" : ""}`,
        },
        [item.icon, " ", item.label, badgeCount ? h("span", { class: "nav__badge" }, [String(badgeCount)]) : null],
      );
    }),
  );
}

export function renderShell(root: HTMLElement, activePath: string, badges: Partial<Record<string, number>> = {}): HTMLElement {
  const session = getSession();
  const nav = buildNav(activePath, badges);

  // Reuse path: the shell is already mounted in this exact root and is
  // still actually attached to the document (isConnected is false the
  // moment a bare page or the not-found handler has cleared root out
  // from under it) — swap only what can differ per navigation.
  if (cachedRoot === root && shellEl && shellEl.isConnected && sidebarEl && navEl && mainEl) {
    sidebarEl.replaceChild(nav, navEl);
    navEl = nav;
    if (userLabelEl) userLabelEl.textContent = session?.user.email ?? "";

    const newMain = h("main", { class: "main" }, []);
    shellEl.replaceChild(newMain, mainEl);
    mainEl = newMain;
    return newMain;
  }

  // First mount for this root, or the previous shell was torn down
  // (logout, or navigating away to a bare page) — build fresh.
  const userLabel = h("div", { class: "sidebar__user" }, [session?.user.email ?? ""]);
  const sidebar = h("aside", { class: "sidebar" }, [
    h("div", { class: "brand" }, [h("span", { class: "brand__mark" }, ["InternshipOS"])]),
    nav,
    h("div", { class: "sidebar__footer" }, [
      userLabel,
      h(
        "button",
        {
          class: "btn btn--small btn--ghost",
          onClick: async () => {
            await signOut();
            navigate("/login");
          },
        },
        ["Sign out"],
      ),
    ]),
  ]);

  const main = h("main", { class: "main" }, []);
  const shell = h("div", { class: "shell" }, [sidebar, main]);

  // Clear the root first — it may still hold a bare page's markup (e.g.
  // navigating from /login straight to /today after sign-in) even though
  // that page's own render function already cleared it once; harmless
  // no-op otherwise.
  clear(root);
  root.append(shell);

  cachedRoot = root;
  shellEl = shell;
  sidebarEl = sidebar;
  navEl = nav;
  userLabelEl = userLabel;
  mainEl = main;
  return main;
}
