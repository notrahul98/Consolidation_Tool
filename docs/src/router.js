// Minimal hash router. Routes are registered as {pattern, render}, where pattern uses
// ":name" segments (e.g. "/periods/:period/mapping"). render(params) is called on match.

const routes = [];
let notFoundRender = () => `<div class="empty">Page not found.</div>`;

function register(pattern, render) {
  const paramNames = [];
  const regex = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            paramNames.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  routes.push({ regex, paramNames, render });
}

function setNotFound(render) {
  notFoundRender = render;
}

function currentPath() {
  const hash = location.hash.slice(1);
  return hash || "/";
}

async function resolve(mountEl) {
  const path = currentPath();
  for (const route of routes) {
    const m = path.match(route.regex);
    if (m) {
      const params = {};
      route.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      await route.render(mountEl, params);
      return;
    }
  }
  await notFoundRender(mountEl, {});
}

function start(mountEl) {
  window.addEventListener("hashchange", () => resolve(mountEl));
  resolve(mountEl);
}

function navigate(path) {
  location.hash = path;
}

export const router = { register, setNotFound, start, navigate, currentPath };
