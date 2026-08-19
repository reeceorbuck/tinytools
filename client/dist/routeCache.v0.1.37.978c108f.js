const ROUTE_CACHE_ATTR = "data-tinytools-route-cache";
const ACTIVE_ROUTE_CACHE_PATH_ATTR = "data-tinytools-active-route-cache-path";
const SPA_REDIRECT_ATTR = "data-spa-redirect";
const LOCAL_TEMPLATE_SOURCE_ATTR = "data-tinytools-local-template-source";
let navGeneration = 0;
function normalizeCachePath(pathname) {
  if (!pathname || pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}
function incrementNavGeneration() {
  const generation = ++navGeneration;
  document.documentElement?.setAttribute(
    "data-tinytools-nav-generation",
    String(generation)
  );
  return generation;
}
function getActiveRouteCachePath(fallbackPathname) {
  return document.documentElement?.getAttribute(ACTIVE_ROUTE_CACHE_PATH_ATTR) ?? normalizeCachePath(fallbackPathname);
}
function isRuntimeCachedRouteTemplate(template) {
  return template.getAttribute(ROUTE_CACHE_ATTR) === "true";
}
function isEmptyRuntimeTemplate(template) {
  const children = template.content.children;
  if (children.length === 0) return true;
  return Array.from(children).every(
    (child) => child.tagName === "PARTIAL-CONTENT" && child.childNodes.length === 0
  );
}
function markLocalTemplateContent(fragment, source) {
  Array.from(fragment.children).forEach((child) => {
    child.setAttribute(LOCAL_TEMPLATE_SOURCE_ATTR, source);
  });
}
function getCachedRouteTemplate(pathname) {
  return document.querySelector(
    `template[path="${pathname}"][${ROUTE_CACHE_ATTR}="true"]`
  );
}
function getOrderedLocalRouteTemplates() {
  const authored = [];
  const placeholders = [];
  const cached = [];
  for (const template of document.querySelectorAll(
    "template[path]"
  )) {
    if (isRuntimeCachedRouteTemplate(template)) {
      cached.push(template);
    } else if (template.hasAttribute("placeholder")) {
      placeholders.push(template);
    } else {
      authored.push(template);
    }
  }
  return [...authored, ...cached, ...placeholders];
}
export {
  LOCAL_TEMPLATE_SOURCE_ATTR,
  SPA_REDIRECT_ATTR,
  getActiveRouteCachePath,
  getCachedRouteTemplate,
  getOrderedLocalRouteTemplates,
  incrementNavGeneration,
  isEmptyRuntimeTemplate,
  isRuntimeCachedRouteTemplate,
  markLocalTemplateContent
};
