const ROUTE_CACHE_ATTR = "data-tinytools-route-cache";
const ACTIVE_ROUTE_CACHE_PATH_ATTR = "data-tinytools-active-route-cache-path";
export const SPA_REDIRECT_ATTR = "data-spa-redirect";
export const LOCAL_TEMPLATE_SOURCE_ATTR =
  "data-tinytools-local-template-source";

let navGeneration = 0;

function normalizeCachePath(pathname: string) {
  if (!pathname || pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function incrementNavGeneration() {
  const generation = ++navGeneration;
  document.documentElement?.setAttribute(
    "data-tinytools-nav-generation",
    String(generation),
  );
  return generation;
}

export function getActiveRouteCachePath(fallbackPathname: string) {
  return document.documentElement?.getAttribute(ACTIVE_ROUTE_CACHE_PATH_ATTR) ??
    normalizeCachePath(fallbackPathname);
}

export function isRuntimeCachedRouteTemplate(template: HTMLTemplateElement) {
  return template.getAttribute(ROUTE_CACHE_ATTR) === "true";
}

export function isEmptyRuntimeTemplate(template: HTMLTemplateElement) {
  const children = template.content.children;
  if (children.length === 0) return true;
  return Array.from(children).every((child) =>
    child.tagName === "PARTIAL-CONTENT" && child.childNodes.length === 0
  );
}

export function markLocalTemplateContent(
  fragment: DocumentFragment,
  source: "authored" | "runtime",
) {
  Array.from(fragment.children).forEach((child) => {
    child.setAttribute(LOCAL_TEMPLATE_SOURCE_ATTR, source);
  });
}

export function getCachedRouteTemplate(pathname: string) {
  return document.querySelector<HTMLTemplateElement>(
    `template[path="${pathname}"][${ROUTE_CACHE_ATTR}="true"]`,
  );
}

export function getOrderedLocalRouteTemplates() {
  const authored: HTMLTemplateElement[] = [];
  const placeholders: HTMLTemplateElement[] = [];
  const cached: HTMLTemplateElement[] = [];

  for (
    const template of document.querySelectorAll<HTMLTemplateElement>(
      "template[path]",
    )
  ) {
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
