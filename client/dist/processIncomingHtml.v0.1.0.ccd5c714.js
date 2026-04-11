import {
  applyIncomingToCachedTemplates,
  CACHE_ID_ATTR,
  cacheStaleIncomingPartials,
  captureOutgoingRouteState,
  ensureElementCacheId,
  establishActiveRouteTemplateReferences,
  getNavGeneration,
  LOCAL_TEMPLATE_SOURCE_ATTR,
  setActiveRouteCachePath
} from "./routeCache.v0.1.0.ccd5c714.js";
function processIncomingHtml(fragment, scope = document, options = {}) {
  console.log("incoming fragment: ", fragment);
  const children = Array.from(fragment.children);
  const isStale = typeof options.navGeneration === "number" && options.navGeneration !== getNavGeneration();
  if (isStale && !options.bypassRouteCache) {
    const registrations = options.activeRouteRegistrations ?? (options.activeRoutePath ? [{ pathname: options.activeRoutePath }] : []);
    if (registrations.length > 0) {
      console.log(
        "Stale navigation response \u2014 caching for:",
        registrations.map((r) => r.pathname).join(", ")
      );
      cacheStaleIncomingPartials(registrations, children);
    }
    return;
  }
  if (scope === document && options.updateCachedTemplates && !options.bypassRouteCache) {
    applyIncomingToCachedTemplates(children);
  }
  if (scope === document && options.cacheCurrentPath && !options.bypassRouteCache) {
    captureOutgoingRouteState(options.cacheCurrentPath, scope);
  }
  if (scope === document) {
    if (options.activeRoutePath && !options.bypassRouteCache) {
      setActiveRouteCachePath(options.activeRoutePath);
    }
    const registrations = options.bypassRouteCache ? [] : options.activeRouteRegistrations ?? (options.activeRoutePath ? [{ pathname: options.activeRoutePath }] : []);
    for (const registration of registrations) {
      establishActiveRouteTemplateReferences(
        registration.pathname,
        children,
        scope,
        { redirectTo: registration.redirectTo }
      );
    }
  }
  children.forEach((partial) => {
    const existing = partial.id ? scope.querySelector(`#${partial.id}`) : null;
    const name = partial.getAttribute("name");
    console.log("Processing partial with id: ", partial.id, " name: ", name);
    if (!existing) {
      if (scope !== document) {
        console.log(
          `No scoped element with id ${partial.id}, skipping scoped update.`
        );
        return;
      }
      if (partial.id || partial.tagName === "PARTIAL") {
        console.log(
          `No existing element with id ${partial.id}, so appending to body?`
        );
        if (partial.tagName === "PARTIAL") {
          console.error(
            `PARTIAL element found without existing counterpart id: ${partial.id}`
          );
        }
        const popup = document.getElementById(
          "global-modal"
        );
        popup.appendChild(partial);
        popup.showModal();
      }
      if (partial.id) {
        ensureElementCacheId(partial);
      }
      document.body.appendChild(partial);
      return;
    }
    const mode = partial.getAttribute("mode") || "replace";
    const groupName = partial.getAttribute("group-name");
    switch (mode) {
      case "attributes": {
        console.log(
          `Updating attributes for element with id ${partial.id}`,
          partial.attributes
        );
        Array.from(partial.attributes).forEach((attr) => {
          if (attr.name !== "id" && attr.name !== "name" && attr.name !== "mode") {
            console.log(`Setting attribute ${attr.name} to ${attr.value}`);
            if (attr.name === "value") {
              existing.value = attr.value;
            } else {
              existing.setAttribute(attr.name, attr.value);
            }
          }
        });
        break;
      }
      case "replace": {
        if (partial.tagName === "PARTIAL") {
          console.log(
            `Replacing child with id ${partial.id} and tag ${partial.tagName}, child length: ${partial.children.length}`
          );
          const cacheId = partial.getAttribute(CACHE_ID_ATTR) || existing.getAttribute(CACHE_ID_ATTR) || ensureElementCacheId(existing);
          partial.setAttribute(CACHE_ID_ATTR, cacheId);
          existing.setAttribute(CACHE_ID_ATTR, cacheId);
          const templateSource = partial.getAttribute(
            LOCAL_TEMPLATE_SOURCE_ATTR
          );
          if (templateSource) {
            existing.setAttribute(LOCAL_TEMPLATE_SOURCE_ATTR, templateSource);
          } else {
            existing.removeAttribute(LOCAL_TEMPLATE_SOURCE_ATTR);
          }
          while (existing.firstChild) {
            existing.firstChild.remove();
          }
          Array.from(partial.childNodes).forEach((child) => {
            existing.appendChild(child);
          });
        } else {
          console.log(`Replacing child with id ${partial.id}`);
          const cacheId = partial.getAttribute(CACHE_ID_ATTR) || existing.getAttribute(CACHE_ID_ATTR) || ensureElementCacheId(existing);
          partial.setAttribute(CACHE_ID_ATTR, cacheId);
          existing.replaceWith(partial);
        }
        break;
      }
      case "blast": {
        if (partial.tagName === "PARTIAL") {
          console.log(
            `Blast replacing child with id ${partial.id} and tag ${partial.tagName}, child length: ${partial.children.length}`
          );
          existing.removeAttribute(LOCAL_TEMPLATE_SOURCE_ATTR);
          existing.replaceWith(...Array.from(partial.children));
        } else {
          console.error("Cannot blast non-partial element");
        }
        break;
      }
      case "delete": {
        console.log(`Deleting child with id ${partial.id}`);
        existing.remove();
        break;
      }
      case "merge-content": {
        Array.from(partial.children).forEach((insertNode) => {
          const searchId = insertNode.getAttribute("match-id") || insertNode.id;
          insertNode.removeAttribute("match-id");
          groupName && insertNode.setAttribute("data-partial-group", groupName);
          let existingChild = searchId ? existing.children.namedItem(searchId) : void 0;
          console.log("Searching for groupName:", groupName);
          console.log(
            "Array.from(existing.children): ",
            Array.from(existing.children)
          );
          let existingMode = partial.getAttribute("existing");
          if (!existingChild) {
            existingMode = partial.getAttribute("group");
            existingChild = groupName ? Array.from(existing.children).find((eChild) => {
              console.log("Comparing with eChild:", eChild);
              console.log(
                'eChild.getAttribute("data-partial-group"):',
                eChild.getAttribute("data-partial-group")
              );
              return eChild.getAttribute("data-partial-group") === groupName;
            }) : void 0;
          }
          console.log("existingChild:", existingChild);
          if (existingChild) {
            console.log(
              `Found existing child within parent block with id ${partial.id}, mode: ${mode}`
            );
            switch (existingMode) {
              case "substitute":
                console.log("insertNode:", insertNode);
                if (insertNode.tagName === "PARTIAL") {
                  const childPartial = new DocumentFragment();
                  const updateChild = document.createElement("update");
                  childPartial.appendChild(updateChild);
                  updateChild.appendChild(insertNode);
                  processIncomingHtml(
                    childPartial,
                    existingChild.parentElement,
                    options
                  );
                } else {
                  existingChild.replaceWith(insertNode);
                }
                break;
              case "match":
                console.log(
                  "Matching existing child with new child, which is sort of a no op"
                );
                break;
              case "substitute(append)":
                existingChild.remove();
              // falls through
              case "match(append)":
                existing.append(insertNode);
                break;
              case "substitute(prepend)":
                existingChild.remove();
              // falls through
              case "match(prepend)":
                existing.prepend(insertNode);
                break;
              default:
                console.error("Unexpected existing mode:", existingMode);
                break;
            }
          } else {
            const newMode = partial.getAttribute("new");
            switch (newMode) {
              case "append":
                existing.append(insertNode);
                break;
              case "prepend":
                existing.prepend(insertNode);
                break;
              case "ignore":
                console.log(
                  `No existing child with id ${insertNode.id}, ignoring as per new="ignore"`
                );
                break;
              default:
                console.error("Unexpected new mode:", insertNode);
                break;
            }
          }
        });
        break;
      }
      default: {
        console.error(`Unknown mode ${mode}, defaulting to replace`);
        existing.replaceWith(partial);
        break;
      }
    }
  });
}
export {
  processIncomingHtml
};
