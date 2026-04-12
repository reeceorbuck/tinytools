const ROUTE_CACHE_TAG = "route-cache";
const ROUTE_CACHE_SEED_TAG = "route-cache-seed";
const ROUTE_CACHE_ATTR = "data-tinytools-route-cache";
const CACHE_ID_ATTR = "data-cache-id";
const SPA_REDIRECT_ATTR = "data-spa-redirect";
const LOCAL_TEMPLATE_SOURCE_ATTR = "data-tinytools-local-template-source";
const ACTIVE_ROUTE_CACHE_PATH_ATTR = "data-tinytools-active-route-cache-path";
let _navGeneration = 0;
function getNavGeneration() {
  return _navGeneration;
}
function incrementNavGeneration() {
  return ++_navGeneration;
}
function normalizeCachePath(pathname) {
  if (!pathname) {
    return pathname;
  }
  if (pathname === "/") {
    return pathname;
  }
  return pathname.replace(/\/+$/, "");
}
function setActiveRouteCachePath(pathname) {
  const normalizedPath = normalizeCachePath(pathname);
  if (!normalizedPath) {
    return;
  }
  document.documentElement?.setAttribute(
    ACTIVE_ROUTE_CACHE_PATH_ATTR,
    normalizedPath
  );
}
function getActiveRouteCachePath(fallbackPathname) {
  return document.documentElement?.getAttribute(ACTIVE_ROUTE_CACHE_PATH_ATTR) ?? normalizeCachePath(fallbackPathname);
}
function escapeId(id) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id);
  }
  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
function findElementInScope(scope, id) {
  if ("getElementById" in scope && typeof scope.getElementById === "function") {
    return scope.getElementById(id);
  }
  return scope.querySelector?.(`#${escapeId(id)}`) ?? null;
}
function getRouteCacheContainerParent() {
  return document.body ?? document.documentElement;
}
function ensureRouteCacheContainer() {
  const existing = document.querySelector(
    `${ROUTE_CACHE_TAG}[data-dynamic]`
  );
  if (existing) {
    return existing;
  }
  const container = document.createElement(ROUTE_CACHE_TAG);
  container.setAttribute("data-dynamic", "");
  container.hidden = true;
  getRouteCacheContainerParent().appendChild(container);
  return container;
}
function adoptTemplateAndCleanSeed(template) {
  const parent = template.parentElement;
  ensureRouteCacheContainer().prepend(template);
  if (parent && parent.tagName === ROUTE_CACHE_SEED_TAG.toUpperCase() && parent.children.length === 0) {
    parent.remove();
  }
}
function clearTemplateContent(template) {
  while (template.content.firstChild) {
    template.content.firstChild.remove();
  }
}
function isSuspenseTransientId(id) {
  return /^suspended-\d+$/i.test(id);
}
function shouldTrackElementForRouteCache(element) {
  if (!element.id) {
    return false;
  }
  if (isSuspenseTransientId(element.id)) {
    return false;
  }
  return true;
}
function getStableAncestorForSuspenseElement(suspenseElement) {
  const ancestorWithId = suspenseElement.parentElement?.closest("[id]");
  if (!(ancestorWithId instanceof Element)) {
    return null;
  }
  if (!ancestorWithId.id || isSuspenseTransientId(ancestorWithId.id)) {
    return null;
  }
  return ancestorWithId;
}
function deriveCacheableElementsFromSuspense(incomingElements, scope) {
  const seen = /* @__PURE__ */ new Set();
  const derived = [];
  for (const element of incomingElements) {
    if (!element.id || !isSuspenseTransientId(element.id)) {
      continue;
    }
    const existingSuspenseElement = findElementInScope(scope, element.id);
    if (!(existingSuspenseElement instanceof Element)) {
      continue;
    }
    const stableAncestor = getStableAncestorForSuspenseElement(
      existingSuspenseElement
    );
    if (!stableAncestor?.id || seen.has(stableAncestor.id)) {
      continue;
    }
    seen.add(stableAncestor.id);
    derived.push(stableAncestor);
  }
  return derived;
}
function createCacheId(prefix = "ttc") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function ensureElementCacheId(element, preferredId) {
  const existing = element.getAttribute(CACHE_ID_ATTR);
  if (existing) {
    return existing;
  }
  const cacheId = preferredId ?? createCacheId();
  element.setAttribute(CACHE_ID_ATTR, cacheId);
  return cacheId;
}
function createCachedRouteTemplate(pathname) {
  const template = document.createElement("template");
  template.setAttribute("path", pathname);
  template.setAttribute("method", "get");
  template.setAttribute("data-nav-block", "");
  template.setAttribute(ROUTE_CACHE_ATTR, "true");
  ensureRouteCacheContainer().prepend(template);
  return template;
}
function isRuntimeCachedRouteTemplate(template) {
  return template.getAttribute(ROUTE_CACHE_ATTR) === "true";
}
function isEmptyRuntimeTemplate(template) {
  const children = template.content.children;
  if (children.length === 0) {
    return true;
  }
  return Array.from(children).every(
    (child) => child.tagName === "PARTIAL" && child.childNodes.length === 0
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
function getOrCreateCachedRouteTemplate(pathname) {
  return getCachedRouteTemplate(pathname) ?? createCachedRouteTemplate(pathname);
}
function createRouteCacheReference(partialId, cacheId) {
  const reference = document.createElement("partial");
  reference.id = partialId;
  reference.setAttribute("mode", "replace");
  reference.setAttribute(CACHE_ID_ATTR, cacheId);
  reference.setAttribute(LOCAL_TEMPLATE_SOURCE_ATTR, "runtime");
  return reference;
}
function upsertRouteCacheReference(template, partialId, cacheId) {
  const existing = findElementInScope(template.content, partialId);
  const reference = createRouteCacheReference(partialId, cacheId);
  if (existing) {
    existing.replaceWith(reference);
    return reference;
  }
  template.content.appendChild(reference);
  return reference;
}
function establishActiveRouteTemplateReferences(pathname, incomingElements, scope = document, options = {}) {
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
    adoptTemplateAndCleanSeed(template);
    return;
  }
  let cacheableElements = incomingElements.filter(
    (element) => shouldTrackElementForRouteCache(element)
  );
  if (cacheableElements.length === 0) {
    cacheableElements = deriveCacheableElementsFromSuspense(
      incomingElements,
      scope
    );
  }
  if (cacheableElements.length === 0) {
    adoptTemplateAndCleanSeed(template);
    return;
  }
  clearTemplateContent(template);
  for (const element of cacheableElements) {
    const elementId = element.id;
    const existing = findElementInScope(scope, elementId);
    const cacheId = element.getAttribute(CACHE_ID_ATTR) || (existing instanceof Element ? existing.getAttribute(CACHE_ID_ATTR) : null) || ensureElementCacheId(element);
    element.setAttribute(CACHE_ID_ATTR, cacheId);
    upsertRouteCacheReference(template, elementId, cacheId);
  }
  adoptTemplateAndCleanSeed(template);
}
function captureStateIntoTemplate(template, scope) {
  const isRedirectAliasTemplate = template.hasAttribute(SPA_REDIRECT_ATTR);
  const references = Array.from(
    template.content.querySelectorAll(`partial[${CACHE_ID_ATTR}]`)
  );
  for (const reference of references) {
    if (!reference.id) {
      continue;
    }
    const existing = findElementInScope(scope, reference.id);
    if (!(existing instanceof Element)) {
      continue;
    }
    if (existing.getAttribute(LOCAL_TEMPLATE_SOURCE_ATTR) === "authored") {
      continue;
    }
    const cacheId = ensureElementCacheId(
      existing,
      reference.getAttribute(CACHE_ID_ATTR) ?? void 0
    );
    reference.setAttribute(CACHE_ID_ATTR, cacheId);
    while (reference.firstChild) {
      reference.firstChild.remove();
    }
    if (isRedirectAliasTemplate) {
      continue;
    }
    Array.from(existing.childNodes).forEach((child) => {
      reference.appendChild(child.cloneNode(true));
    });
  }
}
function captureOutgoingRouteState(pathname, scope = document) {
  if (!pathname) {
    return;
  }
  const allTemplates = document.querySelectorAll(
    `template[${ROUTE_CACHE_ATTR}="true"]`
  );
  for (const template of allTemplates) {
    captureStateIntoTemplate(template, scope);
    adoptTemplateAndCleanSeed(template);
  }
}
function cacheStaleIncomingPartials(registrations, incomingElements) {
  for (const registration of registrations) {
    const template = getOrCreateCachedRouteTemplate(registration.pathname);
    if (registration.redirectTo) {
      template.setAttribute(SPA_REDIRECT_ATTR, registration.redirectTo);
      clearTemplateContent(template);
      adoptTemplateAndCleanSeed(template);
      continue;
    }
    const cacheableElements = incomingElements.filter(
      (el) => shouldTrackElementForRouteCache(el)
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
function getOrderedLocalRouteTemplates() {
  const templates = Array.from(
    document.querySelectorAll("template[path]")
  );
  const cached = templates.filter(isRuntimeCachedRouteTemplate);
  const authored = templates.filter(
    (template) => !isRuntimeCachedRouteTemplate(template)
  );
  return [...cached, ...authored];
}
function applyIncomingToCachedTemplates(incomingElements) {
  if (incomingElements.length === 0) {
    return;
  }
  const cachedTemplates = getOrderedLocalRouteTemplates().filter(
    isRuntimeCachedRouteTemplate
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
      const cacheId = incoming.getAttribute(CACHE_ID_ATTR) || reference.getAttribute(CACHE_ID_ATTR) || ensureElementCacheId(reference);
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
function hydratePartialFromCacheId(_partial) {
}
export {
  CACHE_ID_ATTR,
  LOCAL_TEMPLATE_SOURCE_ATTR,
  SPA_REDIRECT_ATTR,
  applyIncomingToCachedTemplates,
  cacheStaleIncomingPartials,
  captureOutgoingRouteState,
  createCacheId,
  ensureElementCacheId,
  establishActiveRouteTemplateReferences,
  getActiveRouteCachePath,
  getCachedRouteTemplate,
  getNavGeneration,
  getOrderedLocalRouteTemplates,
  hydratePartialFromCacheId,
  incrementNavGeneration,
  isEmptyRuntimeTemplate,
  isRuntimeCachedRouteTemplate,
  markLocalTemplateContent,
  setActiveRouteCachePath
};
