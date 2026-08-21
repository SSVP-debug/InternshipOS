// router.ts — deliberately minimal: hash-based (no server-side routing
// config needed for a static build), a route table of path patterns to
// render functions, and a single #app mount point that gets cleared and
// re-rendered on every navigation.

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

  root.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "page-loading";
  loading.textContent = "Loading…";
  root.append(loading);

  for (const r of routes) {
    const match = path.match(r.pattern);
    if (match) {
      const params: Record<string, string> = {};
      r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
      root.innerHTML = "";
      await r.handler(params, root);
      return;
    }
  }
  root.innerHTML = "";
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
