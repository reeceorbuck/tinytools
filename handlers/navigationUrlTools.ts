import { Handlers, imports } from "../clientTools.ts";
import type { AppNavigation, NavigationClientInfo } from "./navigationTools.ts";

export interface NavigationUrlResult {
  readonly fromUrl: URL;
  readonly toUrl: URL;
  readonly fetchUrl: URL;
  readonly displayUrl: URL;
  readonly shouldRedirect: boolean;
  readonly shouldIntercept: boolean;
  readonly isSameDocumentHashNavigation: boolean;
}

export const parseNavigationUrlsTools = new Handlers(import.meta.url, {
  parseNavigationUrls: function (
    event: Pick<
      NavigateEvent,
      "destination" | "navigationType" | "sourceElement"
    >,
    currentUrl: string = globalThis.location.href,
    blockIntercept = false,
  ): NavigationUrlResult {
    const fromUrl = new URL(currentUrl);
    const toUrl = new URL(event.destination.url);
    const fetchUrl = new URL(toUrl);
    let displayUrl = new URL(toUrl);
    let shouldRedirect = false;
    const normalizePathname = (pathname: string) =>
      pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
    const isSameDocumentHashNavigation = normalizePathname(toUrl.pathname) ===
        normalizePathname(fromUrl.pathname) &&
      toUrl.search === fromUrl.search && toUrl.hash !== "";
    const shouldIntercept = !blockIntercept &&
      !event.sourceElement?.hasAttribute("data-no-intercept") &&
      toUrl.origin === fromUrl.origin && !isSameDocumentHashNavigation;

    if (!shouldIntercept) {
      return {
        fromUrl,
        toUrl,
        fetchUrl,
        displayUrl,
        shouldRedirect,
        shouldIntercept,
        isSameDocumentHashNavigation,
      };
    }

    const form = event.sourceElement instanceof HTMLFormElement
      ? event.sourceElement
      : event.sourceElement && "form" in event.sourceElement
      ? (event.sourceElement as HTMLInputElement | HTMLButtonElement).form
      : null;
    const partialAttr = event.sourceElement?.getAttribute("data-nav-partial") ??
      form?.getAttribute("data-nav-partial");

    if (partialAttr) {
      const partialUrl = new URL(partialAttr, toUrl.href);
      if (!partialUrl.search && toUrl.search) {
        partialUrl.search = toUrl.search;
      }
      fetchUrl.pathname = partialUrl.pathname;
      fetchUrl.search = partialUrl.search;
      fetchUrl.hash = partialUrl.hash;
    }

    if (event.navigationType === "push") {
      for (const [key, value] of [...displayUrl.searchParams]) {
        if (value === "") {
          displayUrl.searchParams.delete(key);
          shouldRedirect = true;
        }
      }

      const redirectAttr =
        event.sourceElement?.getAttribute("data-nav-redirect") ??
          form?.getAttribute("data-nav-redirect");
      if (redirectAttr === "true") {
        displayUrl = new URL(fromUrl);
        shouldRedirect = true;
      } else if (redirectAttr) {
        try {
          displayUrl = new URL(redirectAttr, fromUrl.href);
          shouldRedirect = true;
        } catch (error) {
          console.error("Error parsing data-nav-redirect: ", error);
        }
      }
    }

    return {
      fromUrl,
      toUrl,
      fetchUrl,
      displayUrl,
      shouldRedirect,
      shouldIntercept,
      isSameDocumentHashNavigation,
    };
  },
});

export const navigationUrlTools = new Handlers(import.meta.url, async () => {
  const { fn } = await imports(parseNavigationUrlsTools);
  return {
    getNavigationMethod: function (event: NavigateEvent): "get" | "post" {
      const source = event.sourceElement;
      if (source instanceof HTMLFormElement) {
        return (source.method || "get").toLowerCase() === "post"
          ? "post"
          : "get";
      }
      if (
        source instanceof HTMLButtonElement ||
        source instanceof HTMLInputElement
      ) {
        const explicit = source.getAttribute("formmethod");
        if (explicit) return explicit.toLowerCase() === "post" ? "post" : "get";
        return (source.form?.method || "get").toLowerCase() === "post"
          ? "post"
          : "get";
      }
      if (source && "form" in source) {
        const form = (source as HTMLInputElement | HTMLButtonElement).form;
        if (form) {
          return (form.method || "get").toLowerCase() === "post"
            ? "post"
            : "get";
        }
      }
      return event.formData ? "post" : "get";
    },
    getNavigationUrls: function (event: NavigateEvent): NavigationUrlResult {
      const navigationApi = globalThis.navigation as AppNavigation;
      const cache = navigationApi.navigationUrlResults ??= new WeakMap<
        NavigateEvent,
        NavigationUrlResult
      >();
      const cached = cache.get(event);
      if (cached) return cached;

      const navigationInfo = event.info && typeof event.info === "object"
        ? event.info as NavigationClientInfo
        : null;
      const result = fn.parseNavigationUrls(
        event,
        globalThis.location.href,
        navigationInfo?.blockIntercept,
      );
      cache.set(event, result);
      return result;
    },
  };
});
