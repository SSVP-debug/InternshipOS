// router.ts — deliberately minimal: hash-based (no server-side routing
// config needed for a static build) and a route table of path patterns
// to render functions.
//
// Gate A1 (persistent navigation): this module used to unconditionally
// clear the entire #app mount root before every dispatch — see the old
// version's own header comment — which is what destroyed and rebuilt the
// sidebar shell on every navigation (shell.ts's renderShell() just
// appended a fresh shell into whatever root it was given; it never asked
// for a clean root itself). That pre-clear has been removed. Root
// teardown is now each route handler's own responsibility, which was
// already true in practice for every handler in this codebase:
//   - bare/guest pages (authPages.ts, onboarding.ts) already call
//     clear(root) themselves at the top of their render function.
//   - the notFound handler (main.ts) already does root.innerHTML = ""
//     itself.
//   - shelled pages go through shell.ts's renderShell(), which now owns
//     the decision to reuse an already-mounted shell (persistent
//     sidebar) vs. rebuild one from scratch (see that file's header).
// So removing the router's own clear is behavior-neutral for every
// existing handler except shell.ts, which was rewritten specifically to
// take over that responsibility.

type RouteHandler = (params: Record<string, string>, root: HTMLElement) => void | Promise<void>;

interface Route {
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];
let notFoundHandler: RouteHandler = (_p, root) => {
  root.append(document.createTextNode("Not found."));
};
let root: HTMLElement | null = null;

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${pattern}$`), keys };
}

export function route(path: string, handler: RouteHandler) {
  const { pattern, keys } = compile(path);
  routes.push({ pattern, keys, handler });
}

export function notFound(handler: RouteHandler) {
  notFoundHandler = handler;
}

export function navigate(path: string) {
  window.location.hash = path;
}

async function render() {
  if (!root) return;
  const hash = window.location.hash.slice(1) || "/";
  const path = hash.split("?")[0];

  for (const r of routes) {
    const match = path.match(r.pattern);
    if (match) {
      const params: Record<string, string> = {};
      r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
      await r.handler(params, root);
      return;
    }
  }
  await notFoundHandler({}, root);
}

export function startRouter(mount: HTMLElement) {
  root = mount;
  window.addEventListener("hashchange", render);
  render();
}

export function currentPath(): string {
  return (window.location.hash.slice(1) || "/").split("?")[0];
}
