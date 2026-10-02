import {
  Handlers,
  imports,
  type PartialAbortableHTMLElement,
  tiny,
} from "../mod.ts";
import {
  type NavigationUrlResult,
  navigationUrlTools,
} from "./navigationUrlTools.ts";
import { processIncomingDataTools } from "./processIncomingData.ts";

export type AppNavigation = Navigation & {
  inflightGetRequests?: Map<string, AbortController>;
  clientRouteBlockedEvents?: WeakSet<NavigateEvent>;
  /** Navigations restored from a cached route; other client routes skip them. */
  cacheHandledEvents?: WeakSet<NavigateEvent>;
  navigationUrlResults?: WeakMap<NavigateEvent, NavigationUrlResult>;
};

export interface NavigationClientInfo {
  blockIntercept?: boolean;
  onlyUpdateUrl?: boolean;
}

/** What `performFetchAndUpdate` did, for the navigation log. */
export interface FetchReport {
  outcome: "streaming" | "aborted" | "redirected";
  abortedPreviousGet?: boolean;
  status?: number;
  contentType?: string | null;
  spaRedirect?: string;
  redirectedTo?: string;
}

export const performFetchAndUpdateTools = new Handlers(
  import.meta.url,
  async () => {
    const { fn } = await imports(processIncomingDataTools, navigationUrlTools);
    return {
      performFetchAndUpdate: async function (
        destinationUrl: URL,
        fromUrl: URL,
        toUrl: URL,
        formData?: FormData | null,
        requestMethod: "get" | "post" = formData ? "post" : "get",
      ): Promise<FetchReport> {
        const method = requestMethod.toLowerCase() === "post" ? "post" : "get";
        const report: Partial<FetchReport> = {};

        /** Tracks in-flight GET requests per pathname so rapid-fire calls abort stale ones. */
        const inflightGetRequests = (globalThis.navigation as AppNavigation)
          .inflightGetRequests ??= new Map<string, AbortController>();

        let signal: AbortSignal | undefined;
        if (method === "get") {
          const key = destinationUrl.pathname;
          const existing = inflightGetRequests.get(key);
          if (existing) {
            report.abortedPreviousGet = true;
            existing.abort();
          }
          const controller = new AbortController();
          inflightGetRequests.set(key, controller);
          signal = controller.signal;
        }

        let response: Response;
        try {
          response = await fetch(destinationUrl, {
            method,
            headers: {
              "partial-nav": "true",
              "source-url": fromUrl.pathname + fromUrl.search,
              "destination-url": toUrl.pathname + toUrl.search,
            },
            body: method === "post" ? formData ?? undefined : undefined,
            signal,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return { ...report, outcome: "aborted" };
          }
          throw err;
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        report.status = response.status;
        report.contentType = response.headers.get("Content-Type");
        const spaRedirect = response.headers.get("X-spa-redirect");

        if (spaRedirect) {
          report.spaRedirect = spaRedirect;
          navigation.navigate(
            spaRedirect,
            {
              history: "replace",
              info: {
                onlyUpdateUrl: true,
              },
            },
          );
        }

        // if response is a redirect, we need to follow it
        if (response.redirected) {
          const redirectedUrl = new URL(response.url);
          report.redirectedTo = redirectedUrl.href;
          navigation.navigate(
            redirectedUrl.href,
            {
              history: "replace",
              info: {
                blockIntercept: true,
              },
            },
          );
          return { ...report, outcome: "redirected" };
        }

        fn.processIncomingData(response);

        if (method === "get") {
          inflightGetRequests.delete(destinationUrl.pathname);
        }
        return { ...report, outcome: "streaming" };
      },
    };
  },
);

export const navigationTools = new Handlers(import.meta.url, async () => {
  const { fn } = await imports(
    navigationUrlTools,
    performFetchAndUpdateTools,
  );
  return {
    /**
     * Core `onNavigate` handler: intercepts same-origin navigations and
     * fetches the destination as a partial. Register it on an element with
     * `applyNavigationListener`, e.g. `<body onLoad={fn.applyNavigationListener}
     * onNavigate={fn.handleNavigate}>`.
     */
    handleNavigate: function (this: HTMLElement, e: NavigateEvent) {
      function getNavigationClientInfo(
        e: NavigateEvent,
      ): NavigationClientInfo | null {
        if (!e.info || typeof e.info !== "object") {
          return null;
        }

        return e.info as NavigationClientInfo;
      }

      if (e.defaultPrevented || !e.canIntercept) return;
      try {
        const navigationInfo = getNavigationClientInfo(e);
        const {
          fromUrl,
          toUrl,
          fetchUrl,
          displayUrl,
          shouldRedirect,
          shouldIntercept,
        } = fn.getNavigationUrls(e);

        if (!shouldIntercept) return;

        const startedAt = performance.now();
        const source = e.sourceElement;
        // Everything that happened in this navigation, logged once at the end.
        const details: Record<string, unknown> = {
          type: e.navigationType,
          method: fn.getNavigationMethod(e),
          from: fromUrl.href,
          to: toUrl.href,
          ...(fetchUrl.href !== toUrl.href ? { fetchUrl: fetchUrl.href } : {}),
          ...(shouldRedirect ? { displayUrl: displayUrl.href } : {}),
          source,
          ...(e.formData ? { formData: Object.fromEntries(e.formData) } : {}),
          ...(navigationInfo ? { info: navigationInfo } : {}),
          ...(e.userInitiated ? {} : { userInitiated: false }),
        };
        const logNavigation = (outcome: string, error?: unknown) => {
          details.outcome = outcome;
          details.ms = Math.round(performance.now() - startedAt);
          if (error !== undefined) details.error = error;
          const summary = `NAV ${details.type} ${
            String(details.method).toUpperCase()
          } ${fromUrl.pathname}${fromUrl.search} -> ${toUrl.pathname}${toUrl.search}: ${outcome}`;
          if (error !== undefined) console.error(summary, details);
          else console.log(summary, details);
        };

        e.intercept({
          focusReset: "manual",
          // deno-lint-ignore require-await
          async precommitHandler(controller) {
            try {
              if (shouldRedirect) {
                controller.redirect(displayUrl.href);
              }
            } catch (err) {
              details.precommitError = err;
            }
          },

          async handler() {
            try {
              const navigationApi = globalThis.navigation as AppNavigation;
              if (navigationApi.clientRouteBlockedEvents?.has(e)) {
                details.clientRouteBlocked = true;
              }
              if (navigationApi.cacheHandledEvents?.has(e)) {
                details.restoredFromCache = true;
              }

              if (navigationInfo?.onlyUpdateUrl) {
                return logNavigation("url only");
              }
              if (details.clientRouteBlocked) {
                return logNavigation("handled by client route");
              }
              if (source?.hasAttribute("data-local-only")) {
                // We still may have activated client routes, or changed url
                return logNavigation("local only");
              }

              const { outcome, ...fetchDetails } = await fn
                .performFetchAndUpdate(
                  fetchUrl,
                  fromUrl,
                  displayUrl,
                  e.formData,
                  details.method as "get" | "post",
                );
              details.fetch = fetchDetails;
              logNavigation(
                outcome === "streaming"
                  ? `fetched ${fetchDetails.status}`
                  : outcome,
              );
            } catch (err) {
              logNavigation("error", err);
            }
          },
        });
      } catch (err) {
        console.error("Error handling navigation event: ", err);
        // Going to allow the navigation to proceed as if Navigation API is not supported if there is an error in the handler
        // Right now Safari doesnt support precommitHandler, so this is a workaround for that,
        // But it will also suppress obvious other errors so need to be careful about that
        // e.preventDefault();
      }
    },
    /**
     * Keeps this element's `--path-<index>` and `--param-<key>` properties in
     * sync with the URL. Render the initial values with `urlStyleVariables`.
     */
    setVariablesFromUrl: function (
      this: HTMLElement,
      event: NavigationCurrentEntryChangeEvent,
    ) {
      const fromUrl = new URL(event.from.url!);
      const toUrl = new URL(globalThis.location.href);

      const fromSplitPath = fromUrl.pathname.split("/").filter(Boolean);
      const toSplitPath = toUrl.pathname.split("/").filter(Boolean);
      toSplitPath.forEach((partPath, i) => {
        // Only update path variables if they have changed
        if (partPath !== fromSplitPath[i]) {
          this.style.setProperty(
            `--path-${i}`,
            partPath,
          );
        }
      });
      if (fromSplitPath.length > toSplitPath.length) {
        // Remove extra path parts
        for (let i = toSplitPath.length; i < fromSplitPath.length; i++) {
          this.style.removeProperty(`--path-${i}`);
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
        if (!to) {
          this.style.removeProperty(`--param-${key}`);
        } else {this.style.setProperty(
            `--param-${key}`,
            to,
          );}
      });
    },
  };
});

export const applyNavigationHandlers = new Handlers(
  import.meta.url,
  async () => {
    const { fn } = await imports(navigationUrlTools);
    return {
      /**
       * Forwards interceptable `navigate` events to this element's own
       * `onNavigate` handlers.
       */
      applyNavigationListener: function (
        this: PartialAbortableHTMLElement | typeof globalThis,
        _e: Event,
      ) {
        // <body onLoad> runs with `this === window`, so resolve to the body.
        const element = this === globalThis
          ? document.body as PartialAbortableHTMLElement
          : this as PartialAbortableHTMLElement;
        globalThis.navigation.addEventListener("navigate", (event) => {
          if (
            !element.isConnected || event.defaultPrevented ||
            !event.canIntercept
          ) return;
          const { shouldIntercept } = fn.getNavigationUrls(event);
          if (!shouldIntercept) return;
          tiny.runHandler(element, event);
        }, { signal: element.abortController?.signal });
      },
      applyCurrentEntryChangeListener: function (
        this: PartialAbortableHTMLElement | typeof globalThis,
      ) {
        // <body onLoad> runs with `this === window`, so resolve to the body.
        const element = this === globalThis
          ? document.body as PartialAbortableHTMLElement
          : this as PartialAbortableHTMLElement;
        globalThis.navigation.addEventListener(
          "currententrychange",
          (event) => {
            tiny.runHandler(element, event);
          },
          { signal: element.abortController?.signal },
        );
      },
    };
  },
);
