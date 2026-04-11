const ROUTE_CACHE_TAG = "route-cache";
const ROUTE_CACHE_SEED_TAG = "route-cache-seed";
const ROUTE_CACHE_ATTR = "data-tinytools-route-cache";
export const CACHE_ID_ATTR = "data-cache-id";
export const SPA_REDIRECT_ATTR = "data-spa-redirect";
export const LOCAL_TEMPLATE_SOURCE_ATTR =
  "data-tinytools-local-template-source";
const ACTIVE_ROUTE_CACHE_PATH_ATTR = "data-tinytools-active-route-cache-path";

let _navGeneration = 0;

export function getNavGeneration() {
  return _navGeneration;
}

export function incrementNavGeneration() {
  return ++_navGeneration;
}

function normalizeCachePath(pathname: string) {
  if (!pathname) {
    return pathname;
  }

  if (pathname === "/") {
    return pathname;
  }

  return pathname.replace(/\/+$/, "");
}

export function setActiveRouteCachePath(pathname: string) {
  const normalizedPath = normalizeCachePath(pathname);
  if (!normalizedPath) {
    return;
  }

  document.documentElement?.setAttribute(
    ACTIVE_ROUTE_CACHE_PATH_ATTR,
    normalizedPath,
  );
}

export function getActiveRouteCachePath(fallbackPathname: string) {
  return document.documentElement?.getAttribute(ACTIVE_ROUTE_CACHE_PATH_ATTR) ??
    normalizeCachePath(fallbackPathname);
}

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

function ensureRouteCacheContainer(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(
    `${ROUTE_CACHE_TAG}[data-dynamic]`,
  );
  if (existing) {
    return existing;
  }

  const container = document.createElement(ROUTE_CACHE_TAG) as HTMLElement;
  container.setAttribute("data-dynamic", "");
  container.hidden = true;
  getRouteCacheContainerParent().appendChild(container);
  return container;
}

function adoptTemplateAndCleanSeed(template: HTMLTemplateElement) {
  const parent = template.parentElement;
  ensureRouteCacheContainer().prepend(template);
  if (
    parent &&
    parent.tagName === ROUTE_CACHE_SEED_TAG.toUpperCase() &&
    parent.children.length === 0
  ) {
    parent.remove();
  }
}

function clearTemplateContent(template: HTMLTemplateElement) {
  while (template.content.firstChild) {
    template.content.firstChild.remove();
  }
}

function isSuspenseTransientId(id: string) {
  return /^suspended-\d+$/i.test(id);
}

function shouldTrackElementForRouteCache(
  element: Element,
) {
  if (!element.id) {
    return false;
  }

  if (isSuspenseTransientId(element.id)) {
    return false;
  }

  return true;
}

function getStableAncestorForSuspenseElement(
  suspenseElement: Element,
): Element | null {
  const ancestorWithId = suspenseElement.parentElement?.closest("[id]");
  if (!(ancestorWithId instanceof Element)) {
    return null;
  }

  if (!ancestorWithId.id || isSuspenseTransientId(ancestorWithId.id)) {
    return null;
  }

  return ancestorWithId;
}

function deriveCacheableElementsFromSuspense(
  incomingElements: readonly Element[],
  scope: ParentNode,
) {
  const seen = new Set<string>();
  const derived: Element[] = [];

  for (const element of incomingElements) {
    if (!element.id || !isSuspenseTransientId(element.id)) {
      continue;
    }

    const existingSuspenseElement = findElementInScope(scope, element.id);
    if (!(existingSuspenseElement instanceof Element)) {
      continue;
    }

    const stableAncestor = getStableAncestorForSuspenseElement(
      existingSuspenseElement,
    );
    if (!stableAncestor?.id || seen.has(stableAncestor.id)) {
      continue;
    }

    seen.add(stableAncestor.id);
    derived.push(stableAncestor);
  }

  return derived;
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

export function isEmptyRuntimeTemplate(template: HTMLTemplateElement) {
  const children = template.content.children;
  if (children.length === 0) {
    return true;
  }
  // A template with only empty partial references is effectively empty
  return Array.from(children).every(
    (child) => child.tagName === "PARTIAL" && child.childNodes.length === 0,
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

  if (options.redirectTo) {
    clearTemplateContent(template);
    // Redirect aliases are metadata-only: no parked refs or child HTML.
    adoptTemplateAndCleanSeed(template);
    return;
  }

  let cacheableElements = incomingElements.filter((element) =>
    shouldTrackElementForRouteCache(element)
  );

  if (cacheableElements.length === 0) {
    cacheableElements = deriveCacheableElementsFromSuspense(
      incomingElements,
      scope,
    );
  }

  if (cacheableElements.length === 0) {
    // Streaming suspense chunks often contain only transient suspended-* markers.
    // Keep existing route refs untouched when no stable mapping can be derived.
    adoptTemplateAndCleanSeed(template);
    return;
  }

  clearTemplateContent(template);

  for (const element of cacheableElements) {
    const elementId = element.id;

    const existing = findElementInScope(scope, elementId);
    const cacheId = element.getAttribute(CACHE_ID_ATTR) ||
      (existing instanceof Element
        ? existing.getAttribute(CACHE_ID_ATTR)
        : null) ||
      ensureElementCacheId(element);

    element.setAttribute(CACHE_ID_ATTR, cacheId);
    upsertRouteCacheReference(template, elementId, cacheId);
  }

  adoptTemplateAndCleanSeed(template);
}

function captureStateIntoTemplate(
  template: HTMLTemplateElement,
  scope: ParentNode,
) {
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
}

export function captureOutgoingRouteState(
  pathname: string,
  scope: ParentNode = document,
) {
  if (!pathname) {
    return;
  }

  const normalizedPath = normalizeCachePath(pathname);

  // Only capture into the template for the outgoing path (and any redirect
  // aliases that point to it). Other route templates may share the same
  // partial IDs (e.g. "thirdPanelContent") but belong to different routes
  // and must not be overwritten with the current DOM state.
  const allTemplates = document.querySelectorAll<HTMLTemplateElement>(
    `template[${ROUTE_CACHE_ATTR}="true"]`,
  );

  for (const template of allTemplates) {
    const templatePath = normalizeCachePath(
      template.getAttribute("path") ?? "",
    );
    const redirectTarget = template.getAttribute(SPA_REDIRECT_ATTR);
    const isOutgoingPath = templatePath === normalizedPath;
    const isAliasForOutgoing = redirectTarget != null &&
      normalizeCachePath(
          redirectTarget.split("?")[0].split("#")[0],
        ) === normalizedPath;

    if (!isOutgoingPath && !isAliasForOutgoing) {
      continue;
    }

    captureStateIntoTemplate(template, scope);
    adoptTemplateAndCleanSeed(template);
  }
}

export function cacheStaleIncomingPartials(
  registrations: Array<{ pathname: string; redirectTo?: string }>,
  incomingElements: readonly Element[],
) {
  for (const registration of registrations) {
    const template = getOrCreateCachedRouteTemplate(registration.pathname);
    if (registration.redirectTo) {
      template.setAttribute(SPA_REDIRECT_ATTR, registration.redirectTo);
      clearTemplateContent(template);
      adoptTemplateAndCleanSeed(template);
      continue;
    }

    const cacheableElements = incomingElements.filter((el) =>
      shouldTrackElementForRouteCache(el)
    );

    if (cacheableElements.length === 0) {
      adoptTemplateAndCleanSeed(template);
      continue;
    }

    clearTemplateContent(template);

    for (const element of cacheableElements) {
      const cacheId = element.getAttribute(CACHE_ID_ATTR) || createCacheId();
      element.setAttribute(CACHE_ID_ATTR, cacheId);

      const reference = createRouteCacheReference(element.id, cacheId);
      Array.from(element.childNodes).forEach((child) => {
        reference.appendChild(child.cloneNode(true));
      });
      template.content.appendChild(reference);
    }

    adoptTemplateAndCleanSeed(template);
  }
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
