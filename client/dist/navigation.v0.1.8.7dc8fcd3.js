import { processLocalSuspenseTemplates } from "./localRoutes.v0.1.8.7dc8fcd3.js";
import performFetchAndUpdate from "./performFetchAndUpdate.v0.1.8.7dc8fcd3.js";
import {
  getActiveRouteCachePath,
  incrementNavGeneration
} from "./routeCache.v0.1.8.7dc8fcd3.js";
function normalizePathname(pathname) {
  if (pathname === "/") {
    return pathname;
  }
  return pathname.replace(/\/+$/, "");
}
function getNavigationMethod(e) {
  if (e.sourceElement instanceof HTMLFormElement) {
    return (e.sourceElement.method || "get").toLowerCase() === "post" ? "post" : "get";
  }
  if (e.sourceElement && "form" in e.sourceElement) {
    const form = e.sourceElement.form;
    if (form) {
      return (form.method || "get").toLowerCase() === "post" ? "post" : "get";
    }
  }
  return e.formData ? "post" : "get";
}
function hasTruthyNoCacheAttr(element) {
  if (!element || !element.hasAttribute("data-no-cache")) {
    return false;
  }
  const rawValue = element.getAttribute("data-no-cache");
  if (rawValue === null || rawValue === "") {
    return true;
  }
  return rawValue.toLowerCase() !== "false";
}
function getNavigationSourceForm(sourceElement) {
  if (sourceElement instanceof HTMLFormElement) {
    return sourceElement;
  }
  if (sourceElement && "form" in sourceElement) {
    return sourceElement.form;
  }
  return null;
}
function shouldBypassRouteCache(e) {
  if (e.sourceElement instanceof Element && hasTruthyNoCacheAttr(e.sourceElement)) {
    return true;
  }
  const sourceForm = getNavigationSourceForm(e.sourceElement);
  return hasTruthyNoCacheAttr(sourceForm);
}
globalThis.navigation.addEventListener(
  "navigate",
  (e) => {
    try {
      const fromUrl = new URL(globalThis.location.href);
      const toUrl = new URL(e.destination.url);
      const fetchUrl = new URL(toUrl);
      if (e.sourceElement && e.sourceElement.hasAttribute("data-no-intercept") || toUrl.origin !== fromUrl.origin || e.info && e.info.blockIntercept) {
        console.log(
          "Navigation no intercept"
        );
        return;
      }
      const isSameDocumentHashNavigation = normalizePathname(toUrl.pathname) === normalizePathname(fromUrl.pathname) && toUrl.search === fromUrl.search && toUrl.hash !== "";
      if (isSameDocumentHashNavigation) {
        console.log(
          "Navigation hash-only update, skipping SPA intercept for native anchor behavior."
        );
        return;
      }
      console.log("e.sourceElement: ", e.sourceElement);
      const partialAttr = e.sourceElement?.getAttribute("data-nav-partial") ?? (e.sourceElement instanceof HTMLFormElement ? e.sourceElement : e.sourceElement && "form" in e.sourceElement ? e.sourceElement.form : null)?.getAttribute("data-nav-partial");
      console.log("Found data-nav-partial attribute: ", partialAttr);
      if (partialAttr) {
        const partialUrl = new URL(partialAttr, toUrl.href);
        if (!partialUrl.search && toUrl.search) {
          partialUrl.search = toUrl.search;
        }
        fetchUrl.pathname = partialUrl.pathname;
        fetchUrl.search = partialUrl.search;
        fetchUrl.hash = partialUrl.hash;
        console.log("orginal destination url: ", e.destination.url);
      }
      console.log("New Navigation event: ", e);
      const bypassRouteCache = shouldBypassRouteCache(e);
      if (bypassRouteCache) {
        console.log("Route cache bypass enabled via data-no-cache");
      }
      e.intercept({
        focusReset: "manual",
        // deno-lint-ignore require-await
        async precommitHandler(controller) {
          if (e.navigationType === "push") {
            try {
              let cleaned = false;
              const cleanUrl = new URL(toUrl);
              [...cleanUrl.searchParams].forEach(([key, value]) => {
                console.log("Checking param for cleaning: ", key, value);
                if (value === "") {
                  console.log("Removing empty param: ", key);
                  cleanUrl.searchParams.delete(key);
                  cleaned = true;
                }
              });
              if (cleaned) {
                console.log("Cleaned URL: ", cleanUrl.href);
                controller.redirect(cleanUrl.href);
                toUrl.pathname = cleanUrl.pathname;
              }
            } catch (err) {
              console.error("Error cleaning URL: ", err);
            }
            console.log(
              "In precommitHandler for navigation to: ",
              e.destination.url
            );
            console.log(
              "e.sourceElement: ",
              e.sourceElement?.form
            );
            try {
              const redirectAttr = (e.sourceElement instanceof HTMLFormElement ? e.sourceElement : e.sourceElement && "form" in e.sourceElement ? e.sourceElement.form : null)?.getAttribute("data-nav-redirect") ?? e.sourceElement?.getAttribute("data-nav-redirect");
              console.log("Found data-nav-redirect attribute: ", redirectAttr);
              if (redirectAttr === "true") {
                console.log(
                  "data-nav-redirect is true, keeping current URL in address bar"
                );
                controller.redirect(fromUrl.href);
              } else if (redirectAttr) {
                const displayUrl = new URL(
                  redirectAttr,
                  globalThis.location.href
                );
                console.log("redirecting to custom URL: ", displayUrl.href);
                controller.redirect(displayUrl.href);
                toUrl.pathname = displayUrl.pathname;
              } else {
                console.log(
                  "No data-nav-redirect attribute, proceeding with normal url update to: ",
                  toUrl.href
                );
              }
            } catch (err) {
              console.error("Error in pre-commit handler: ", err);
            }
          }
          setVariablesFromUrl(fromUrl, toUrl);
        },
        // deno-lint-ignore require-await
        async handler() {
          try {
            console.log("In navigation handler for fetchUrl: ", fetchUrl.href);
            const navigationMethod = getNavigationMethod(e);
            const localRouteUrl = fetchUrl;
            const cacheCurrentPath = navigationMethod === "get" ? getActiveRouteCachePath(fromUrl.pathname) : void 0;
            if (e.info?.onlyUpdateUrl) {
              console.log(
                "Navigation event onlyUpdateUrl, no fetch performed."
              );
              return;
            }
            const navGeneration = incrementNavGeneration();
            try {
              const block = processLocalSuspenseTemplates(
                localRouteUrl,
                e.formData ?? null,
                cacheCurrentPath,
                navigationMethod,
                { allowRuntimeCache: !bypassRouteCache }
              );
              if (block) {
                console.log(
                  "Blocking navigation for this local route due to template."
                );
                return;
              }
            } catch (err) {
              console.error("Error in processLocalSuspenseTemplates: ", err);
            }
            if (e.sourceElement?.hasAttribute("data-local-only")) {
              console.log(
                "Navigation event is local only, no fetch performed."
              );
              return;
            }
            console.log(
              `NAV: Fetching from ${fetchUrl.href}, updating url to ${toUrl.href}`
            );
            return await performFetchAndUpdate(
              fetchUrl,
              fromUrl,
              toUrl,
              e.formData,
              navigationMethod,
              { bypassRouteCache, navGeneration }
            );
          } catch (err) {
            console.error("Error in navigation handler: ", err);
          }
        }
      });
    } catch (err) {
      console.error("Error handling navigation event: ", err);
      e.preventDefault();
    }
  }
);
function setVariablesFromUrl(fromUrl, toUrl) {
  const fromSplitPath = fromUrl.pathname.split("/").filter(Boolean);
  const toSplitPath = toUrl.pathname.split("/").filter(Boolean);
  toSplitPath.forEach((partPath, i) => {
    if (partPath !== fromSplitPath[i]) {
      document.documentElement.style.setProperty(`--path-${i}`, partPath);
    }
  });
  if (fromSplitPath.length > toSplitPath.length) {
    for (let i = toSplitPath.length; i < fromSplitPath.length; i++) {
      document.documentElement.style.removeProperty(`--path-${i}`);
    }
  }
  const fromParams = fromUrl.searchParams;
  const paramChanges = toUrl.searchParams.entries().toArray().map(
    ([key, value]) => {
      if (fromParams.get(key) === value) return null;
      return {
        key,
        from: fromParams.get(key),
        to: value || null
      };
    }
  ).concat(
    fromParams.entries().toArray().map(([key, value]) => {
      if (toUrl.searchParams.has(key)) return null;
      return {
        key,
        from: value || null,
        to: null
      };
    })
  ).filter((change) => change !== null);
  const changeMap = new Map(paramChanges.map(({ key, ...rest }) => [
    key,
    rest
  ]));
  changeMap.forEach(({ to }, key) => {
    if (!to) document.documentElement.style.removeProperty(`--param-${key}`);
    else document.documentElement.style.setProperty(`--param-${key}`, to);
  });
}
