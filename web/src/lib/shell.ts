// shell.ts — the persistent-feeling sidebar shell wrapped around every
// authenticated page. Re-built on each render() call (the whole #app root
// is cleared per navigation — see router.ts) but cheap enough at this
// app's scale that a "real" persistent shell isn't worth the complexity.

import { h } from "./dom";
import { getSession, signOut } from "./auth";
import { currentPath, navigate } from "./router";

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/today", label: "Today", icon: "☉" },
  { path: "/opportunities", label: "Opportunities", icon: "◈" },
  { path: "/applications", label: "Applications", icon: "▤" },
  { path: "/truth-center", label: "Truth Center", icon: "✓" },
  { path: "/profile", label: "Profile", icon: "◎" },
  { path: "/settings", label: "Settings", icon: "⚙" },
];

export function renderShell(root: HTMLElement, activePath: string, badges: Partial<Record<string, number>> = {}): HTMLElement {
  const session = getSession();

  const nav = h(
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

  const sidebar = h("aside", { class: "sidebar" }, [
    h("div", { class: "brand" }, [h("span", { class: "brand__mark" }, ["InternshipOS"])]),
    nav,
    h("div", { class: "sidebar__footer" }, [
      h("div", { class: "sidebar__user" }, [session?.user.email ?? ""]),
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
  root.append(shell);
  return main;
}
