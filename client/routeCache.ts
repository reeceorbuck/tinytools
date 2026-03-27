const ROUTE_CACHE_CONTAINER_ID = "__tinytools_route_cache";
const ROUTE_CACHE_ATTR = "data-tinytools-route-cache";
export const CACHE_ID_ATTR = "data-cache-id";
export const SPA_REDIRECT_ATTR = "data-spa-redirect";
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

export function createCacheId(prefix = "ttc") {
  if (
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${
    Math.random().toString(36).slice(2, 8)
  }`;
}

export function ensureElementCacheId(element: Element, preferredId?: string) {
  const existing = element.getAttribute(CACHE_ID_ATTR);
  if (existing) {
    return existing;
  }

  const cacheId = preferredId ?? createCacheId();
  element.setAttribute(CACHE_ID_ATTR, cacheId);
  return cacheId;
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

function createRouteCacheReference(partialId: string, cacheId: string) {
  const reference = document.createElement("partial");
  reference.id = partialId;
  reference.setAttribute("mode", "replace");
  reference.setAttribute(CACHE_ID_ATTR, cacheId);
  reference.setAttribute(LOCAL_TEMPLATE_SOURCE_ATTR, "runtime");
  return reference;
}

function upsertRouteCacheReference(
  template: HTMLTemplateElement,
  partialId: string,
  cacheId: string,
) {
  const existing = findElementInScope(template.content, partialId);
  const reference = createRouteCacheReference(partialId, cacheId);
  if (existing) {
    existing.replaceWith(reference);
    return reference;
  }
  template.content.appendChild(reference);
  return reference;
}

export function establishActiveRouteTemplateReferences(
  pathname: string,
  incomingElements: readonly Element[],
  scope: ParentNode = document,
  options: {
    redirectTo?: string;
  } = {},
) {
  if (!pathname) {
    return;
  }

  const template = getOrCreateCachedRouteTemplate(pathname);
  if (options.redirectTo) {
    template.setAttribute(SPA_REDIRECT_ATTR, options.redirectTo);
  } else {
    template.removeAttribute(SPA_REDIRECT_ATTR);
  }
  clearTemplateContent(template);

  if (options.redirectTo) {
    // Redirect aliases are metadata-only: no parked refs or child HTML.
    ensureRouteCacheContainer().prepend(template);
    return;
  }

  for (const element of incomingElements) {
    if (!element.id) {
      continue;
    }

    const existing = findElementInScope(scope, element.id);
    const cacheId = element.getAttribute(CACHE_ID_ATTR) ||
      (existing instanceof Element
        ? existing.getAttribute(CACHE_ID_ATTR)
        : null) ||
      ensureElementCacheId(element);

    element.setAttribute(CACHE_ID_ATTR, cacheId);
    upsertRouteCacheReference(template, element.id, cacheId);
  }

  ensureRouteCacheContainer().prepend(template);
}

export function captureOutgoingRouteState(
  pathname: string,
  scope: ParentNode = document,
) {
  if (!pathname) {
    return;
  }

  const template = getCachedRouteTemplate(pathname);
  if (!template) {
    return;
  }

  const isRedirectAliasTemplate = template.hasAttribute(SPA_REDIRECT_ATTR);

  const references = Array.from(
    template.content.querySelectorAll<Element>(`partial[${CACHE_ID_ATTR}]`),
  );

  for (const reference of references) {
    if (!reference.id) {
      continue;
    }

    const existing = findElementInScope(scope, reference.id);
    if (!(existing instanceof Element)) {
      continue;
    }
    // Local authored suspense/loading DOM is transient and should never be parked.
    if (existing.getAttribute(LOCAL_TEMPLATE_SOURCE_ATTR) === "authored") {
      continue;
    }

    const cacheId = ensureElementCacheId(
      existing,
      reference.getAttribute(CACHE_ID_ATTR) ?? undefined,
    );
    reference.setAttribute(CACHE_ID_ATTR, cacheId);

    while (reference.firstChild) {
      reference.firstChild.remove();
    }
    if (isRedirectAliasTemplate) {
      // Redirect aliases only act as pointers and should not park HTML content.
      continue;
    }
    Array.from(existing.childNodes).forEach((child) => {
      reference.appendChild(child.cloneNode(true));
    });
  }

  ensureRouteCacheContainer().prepend(template);
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

export function applyIncomingToCachedTemplates(
  incomingElements: readonly Element[],
) {
  if (incomingElements.length === 0) {
    return;
  }

  const cachedTemplates = getOrderedLocalRouteTemplates().filter(
    isRuntimeCachedRouteTemplate,
  );

  for (const template of cachedTemplates) {
    const isRedirectAliasTemplate = template.hasAttribute(SPA_REDIRECT_ATTR);
    for (const incoming of incomingElements) {
      if (!incoming.id) {
        continue;
      }

      const reference = findElementInScope(template.content, incoming.id);
      if (!(reference instanceof Element)) {
        continue;
      }

      const cacheId = incoming.getAttribute(CACHE_ID_ATTR) ||
        reference.getAttribute(CACHE_ID_ATTR) ||
        ensureElementCacheId(reference);
      reference.setAttribute(CACHE_ID_ATTR, cacheId);
      reference.setAttribute(LOCAL_TEMPLATE_SOURCE_ATTR, "runtime");

      if (incoming.tagName === "PARTIAL") {
        while (reference.firstChild) {
          reference.firstChild.remove();
        }
        if (isRedirectAliasTemplate) {
          continue;
        }
        Array.from(incoming.childNodes).forEach((child) => {
          reference.appendChild(child.cloneNode(true));
        });
      }
    }
  }
}

// Legacy compatibility hook: refs now carry parked content directly.
export function hydratePartialFromCacheId(_partial: Element) {
}
