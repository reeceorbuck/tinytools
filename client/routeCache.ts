const ROUTE_CACHE_CONTAINER_ID = "__tinytools_route_cache";
const ROUTE_CACHE_ATTR = "data-tinytools-route-cache";
export const LOCAL_TEMPLATE_SOURCE_ATTR =
  "data-tinytools-local-template-source";

function escapeId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }

  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function findElementInScope(scope: ParentNode, id: string): Element | null {
  if ("getElementById" in scope && typeof scope.getElementById === "function") {
    return scope.getElementById(id);
  }

  return scope.querySelector?.(`#${escapeId(id)}`) ?? null;
}

function getRouteCacheContainerParent() {
  return document.body ?? document.documentElement;
}

function ensureRouteCacheContainer(): HTMLDivElement {
  const existing = document.getElementById(ROUTE_CACHE_CONTAINER_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const container = document.createElement("div");
  container.id = ROUTE_CACHE_CONTAINER_ID;
  container.hidden = true;
  getRouteCacheContainerParent().appendChild(container);
  return container;
}

function clearTemplateContent(template: HTMLTemplateElement) {
  while (template.content.firstChild) {
    template.content.firstChild.remove();
  }
}

function createCachedRouteTemplate(pathname: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.setAttribute("path", pathname);
  template.setAttribute("method", "get");
  template.setAttribute("data-nav-block", "");
  template.setAttribute(ROUTE_CACHE_ATTR, "true");
  ensureRouteCacheContainer().prepend(template);
  return template;
}

export function isRuntimeCachedRouteTemplate(template: HTMLTemplateElement) {
  return template.getAttribute(ROUTE_CACHE_ATTR) === "true";
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

function getOrCreateCachedRouteTemplate(pathname: string) {
  return getCachedRouteTemplate(pathname) ??
    createCachedRouteTemplate(pathname);
}

export function beginRouteSnapshot(pathname: string) {
  const template = getOrCreateCachedRouteTemplate(pathname);
  ensureRouteCacheContainer().prepend(template);
  return template;
}

export function upsertCachedRouteSnapshot(
  pathname: string,
  elements: readonly Element[],
) {
  if (!pathname || elements.length === 0) {
    return;
  }

  const template = getOrCreateCachedRouteTemplate(pathname);
  const replacedIds = new Set<string>();
  for (const element of elements) {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) {
      continue;
    }

    if (!clone.id) {
      template.content.appendChild(clone);
      continue;
    }

    const existing = findElementInScope(template.content, clone.id);
    if (existing) {
      existing.replaceWith(clone);
      replacedIds.add(clone.id);
      continue;
    }

    template.content.appendChild(clone);
    replacedIds.add(clone.id);
  }

  ensureRouteCacheContainer().prepend(template);
}

export function snapshotRouteFromLiveDom(
  pathname: string,
  incomingElements: readonly Element[],
  scope: ParentNode = document,
) {
  if (!pathname || incomingElements.length === 0) {
    return;
  }

  const elementsToCache = new Map<string, Element>();
  for (const element of incomingElements) {
    if (!element.id) {
      continue;
    }

    const existing = findElementInScope(scope, element.id);
    if (!(existing instanceof Element)) {
      continue;
    }

    if (existing.getAttribute(LOCAL_TEMPLATE_SOURCE_ATTR) === "authored") {
      continue;
    }

    elementsToCache.set(element.id, existing.cloneNode(true) as Element);
  }

  upsertCachedRouteSnapshot(pathname, [...elementsToCache.values()]);
}

export function getOrderedLocalRouteTemplates() {
  const templates = Array.from(
    document.querySelectorAll<HTMLTemplateElement>("template[path]"),
  );

  const cached = templates.filter(isRuntimeCachedRouteTemplate);
  const authored = templates.filter((template) =>
    !isRuntimeCachedRouteTemplate(template)
  );
  return [...cached, ...authored];
}

export function buildCachedTemplateUpdateBatches(
  incomingElements: readonly Element[],
) {
  const batches: Array<{
    template: HTMLTemplateElement;
    fragment: DocumentFragment;
  }> = [];

  const cachedTemplates = getOrderedLocalRouteTemplates().filter(
    isRuntimeCachedRouteTemplate,
  );

  for (const template of cachedTemplates) {
    const fragment = document.createDocumentFragment();
    for (const element of incomingElements) {
      if (!element.id) {
        continue;
      }

      const existing = findElementInScope(template.content, element.id);
      if (!existing) {
        continue;
      }

      fragment.appendChild(element.cloneNode(true));
    }

    if (fragment.children.length > 0) {
      batches.push({ template, fragment });
    }
  }

  return batches;
}
