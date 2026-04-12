/**
 * Navigation client script for @tinytools/hono-tools
 *
 * Intercepts browser navigation events and performs partial page updates.
 */

import { processLocalSuspenseTemplates } from "./localRoutes.ts";
import performFetchAndUpdate from "./performFetchAndUpdate.ts";
import {
  getActiveRouteCachePath,
  incrementNavGeneration,
} from "./routeCache.ts";

function normalizePathname(pathname: string) {
  if (pathname === "/") {
    return pathname;
  }

  return pathname.replace(/\/+$/, "");
}

function getNavigationMethod(e: NavigateEvent): "get" | "post" {
  if (e.sourceElement instanceof HTMLFormElement) {
    return (e.sourceElement.method || "get").toLowerCase() === "post"
      ? "post"
      : "get";
  }

  if (e.sourceElement && "form" in e.sourceElement) {
    const form = (e.sourceElement as HTMLInputElement | HTMLButtonElement).form;
    if (form) {
      return (form.method || "get").toLowerCase() === "post" ? "post" : "get";
    }
  }

  return e.formData ? "post" : "get";
}

function hasTruthyNoCacheAttr(element: Element | null) {
  if (!element || !element.hasAttribute("data-no-cache")) {
    return false;
  }

  const rawValue = element.getAttribute("data-no-cache");
  if (rawValue === null || rawValue === "") {
    return true;
  }

  return rawValue.toLowerCase() !== "false";
}

function getNavigationSourceForm(
  sourceElement: EventTarget | null,
): HTMLFormElement | null {
  if (sourceElement instanceof HTMLFormElement) {
    return sourceElement;
  }

  if (sourceElement && "form" in sourceElement) {
    return (sourceElement as HTMLInputElement | HTMLButtonElement).form;
  }

  return null;
}

function shouldBypassRouteCache(e: NavigateEvent) {
  if (
    e.sourceElement instanceof Element && hasTruthyNoCacheAttr(e.sourceElement)
  ) {
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

      // If info has blockIntercept, don't intercept
      // If different origin, dont intercept, just let it happen
      // If a tag contains an attribute data-no-intercept, don't intercept
      if (
        (e.sourceElement &&
          e.sourceElement.hasAttribute("data-no-intercept")) ||
        toUrl.origin !== fromUrl.origin ||
        (e.info && e.info.blockIntercept)
      ) {
        console.log(
          "Navigation no intercept",
        );
        // This return means there will be a full page navigation, instead of intercepting
        return;
      }

      const isSameDocumentHashNavigation = normalizePathname(toUrl.pathname) ===
          normalizePathname(fromUrl.pathname) &&
        toUrl.search === fromUrl.search &&
        toUrl.hash !== "";
      // && toUrl.hash !== fromUrl.hash;
      if (isSameDocumentHashNavigation) {
        console.log(
          "Navigation hash-only update, skipping SPA intercept for native anchor behavior.",
        );
        return;
      }

      console.log("e.sourceElement: ", e.sourceElement);

      const partialAttr = e.sourceElement?.getAttribute("data-nav-partial") ??
        (e.sourceElement instanceof HTMLFormElement
          ? e.sourceElement
          : e.sourceElement && "form" in e.sourceElement
          ? (e.sourceElement as HTMLInputElement | HTMLButtonElement).form
          : null)?.getAttribute("data-nav-partial");
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

      // if (
      //   e.formData ||
      //   e.sourceElement instanceof HTMLFormElement ||
      //   (e.sourceElement && "form" in e.sourceElement)
      // ) {
      //   const form = e.sourceElement as HTMLFormElement;
      //   if (form.hasAttribute("data-update-url")) {
      //     console.log(
      //       "Navigation event is a form submission, but has data-update-url, so intercept with url update",
      //     );
      //   } else {
      //     e.preventDefault();
      //     console.log(
      //       "Navigation event prevented due to form submission, ie. fetch but no url or query param change: ",
      //       e,
      //     );
      //     await performFetchAndUpdate(toUrl, fromUrl, e.formData);
      //     return;
      //   }
      // }

      e.intercept({
        focusReset: "manual",
        // deno-lint-ignore require-await
        async precommitHandler(controller) {
          if (e.navigationType === "push") {
            // This is where we can modify the URL in the address bar, to either keep as is for a POST form submission,
            // or to clean up additional get query params that were only needed for the fetch

            // We are going to preserve the query params as state
            // const currentParams = fromUrl.searchParams;

            // console.log(
            //   "toUrl params before cleaning: ",
            //   toUrl.searchParams.toString(),
            // );

            // currentParams.forEach((value, key) => {
            //   if (toUrl.searchParams.get(key) === null) {
            //     toUrl.searchParams.set(key, value);
            //   }
            // });
            // Dont clean if its a partial navigation

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

            // Should be an attribute on the form, or the link, to indicate what to do here
            console.log(
              "In precommitHandler for navigation to: ",
              e.destination.url,
            );
            console.log(
              "e.sourceElement: ",
              (e.sourceElement as HTMLButtonElement)?.form,
            );
            try {
              const redirectAttr = (e.sourceElement instanceof HTMLFormElement
                ? e.sourceElement
                : e.sourceElement && "form" in e.sourceElement
                ? (e.sourceElement as HTMLInputElement | HTMLButtonElement).form
                : null)?.getAttribute("data-nav-redirect") ??
                e.sourceElement?.getAttribute("data-nav-redirect");
              console.log("Found data-nav-redirect attribute: ", redirectAttr);
              if (redirectAttr === "true") {
                console.log(
                  "data-nav-redirect is true, keeping current URL in address bar",
                );
                controller.redirect(fromUrl.href);
              } else if (redirectAttr) {
                const displayUrl = new URL(
                  redirectAttr,
                  globalThis.location.href,
                );
                // displayUrl.searchParams.delete("date_input"); <-- example of deleting a query param after use
                console.log("redirecting to custom URL: ", displayUrl.href);
                controller.redirect(displayUrl.href);
                toUrl.pathname = displayUrl.pathname;
              } else {
                console.log(
                  "No data-nav-redirect attribute, proceeding with normal url update to: ",
                  toUrl.href,
                );
              }
            } catch (err) {
              console.error("Error in pre-commit handler: ", err);
            }
          }
          setVariablesFromUrl(fromUrl, toUrl);
        },

        async handler() {
          try {
            console.log("In navigation handler for fetchUrl: ", fetchUrl.href);
            const navigationMethod = getNavigationMethod(e);
            const localRouteUrl = fetchUrl;
            const cacheCurrentPath = navigationMethod === "get"
              ? getActiveRouteCachePath(fromUrl.pathname)
              : undefined;
            if (e.info?.onlyUpdateUrl) {
              console.log(
                "Navigation event onlyUpdateUrl, no fetch performed.",
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
                { allowRuntimeCache: !bypassRouteCache },
              );
              if (block) {
                console.log(
                  "Blocking navigation for this local route due to template.",
                );
                return;
              }
            } catch (err) {
              console.error("Error in processLocalSuspenseTemplates: ", err);
            }

            if (e.sourceElement?.hasAttribute("data-local-only")) {
              console.log(
                "Navigation event is local only, no fetch performed.",
              );
              return;
            }

            console.log(
              `NAV: Fetching from ${fetchUrl.href}, updating url to ${toUrl.href}`,
            );

            return await performFetchAndUpdate(
              fetchUrl,
              fromUrl,
              toUrl,
              e.formData,
              navigationMethod,
              { bypassRouteCache, navGeneration },
            );
          } catch (err) {
            console.error("Error in navigation handler: ", err);
          }
        },
      });
    } catch (err) {
      console.error("Error handling navigation event: ", err);
      e.preventDefault();
    }
  },
);

// MOVED inside precommit handler to run earlier
// navigation.addEventListener(
//   "currententrychange",
//   (e: NavigationCurrentEntryChangeEvent) => {
//     console.log("Navigation current entry change event fired");
//     const toUrl = new URL(globalThis.navigation.currentEntry?.url!);
//     const fromUrl = new URL(e.from.url!);

//     setVariablesFromUrl(fromUrl, toUrl);

//   },
// );

function setVariablesFromUrl(fromUrl: URL, toUrl: URL) {
  const fromSplitPath = fromUrl.pathname.split("/").filter(Boolean);
  const toSplitPath = toUrl.pathname.split("/").filter(Boolean);
  toSplitPath.forEach((partPath, i) => {
    // Only update path variables if they have changed
    if (partPath !== fromSplitPath[i]) {
      document.documentElement.style.setProperty(`--path-${i}`, partPath);
    }
  });
  if (fromSplitPath.length > toSplitPath.length) {
    // Remove extra path parts
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
        to: value || null,
      };
    },
  ).concat(
    fromParams.entries().toArray().map(([key, value]) => {
      if (toUrl.searchParams.has(key)) return null;
      return {
        key,
        from: value || null,
        to: null,
      };
    }),
  ).filter((change) => change !== null);
  const changeMap = new Map(paramChanges.map(({ key, ...rest }) => [
    key,
    rest,
  ]));
  changeMap.forEach(({ to }, key) => {
    if (!to) document.documentElement.style.removeProperty(`--param-${key}`);
    else document.documentElement.style.setProperty(`--param-${key}`, to);
  });
}
