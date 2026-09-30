import {
  Handlers,
  imports,
  PartialAbortableHTMLElement,
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
  navigationUrlResults?: WeakMap<NavigateEvent, NavigationUrlResult>;
  controller?: AbortController;
};

export interface NavigationClientInfo {
  blockIntercept?: boolean;
  onlyUpdateUrl?: boolean;
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
      ) {
        const method = requestMethod.toLowerCase() === "post" ? "post" : "get";
        console.log(
          `${method.toUpperCase()} Navigation to: ${destinationUrl.href}`,
        );

        const inflightGetRequests = (globalThis.navigation as AppNavigation)
          .inflightGetRequests!;

        let signal: AbortSignal | undefined;
        if (method === "get") {
          const key = destinationUrl.pathname;
          const existing = inflightGetRequests.get(key);
          if (existing) {
            console.log(`Aborting previous GET to ${key}`);
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
            console.log(`GET to ${destinationUrl.href} was aborted`);
            return;
          }
          throw err;
        }

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const spaRedirect = response.headers.get("X-spa-redirect");

        if (spaRedirect) {
          console.log(
            "Found X-spa-redirect header, navigating to: ",
            spaRedirect,
          );
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
          console.log("Redirected to: ", redirectedUrl);
          navigation.navigate(
            redirectedUrl.href,
            {
              history: "replace",
              info: {
                blockIntercept: true,
              },
            },
          );
          return;
        }

        fn.processIncomingData(response);

        if (method === "get") {
          inflightGetRequests.delete(destinationUrl.pathname);
        }
      },
    };
  },
);

export const navigationHandlerTools = new Handlers(
  import.meta.url,
  async () => {
    const { fn } = await imports(
      processIncomingDataTools,
      navigationUrlTools,
      performFetchAndUpdateTools,
    );
    return {
      navigationHandler: function (e: NavigateEvent) {
        function getNavigationClientInfo(
          e: NavigateEvent,
        ): NavigationClientInfo | null {
          if (!e.info || typeof e.info !== "object") {
            return null;
          }

          return e.info as NavigationClientInfo;
        }

        console.log("Core Navigation event: ", e);
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

          if (!shouldIntercept) {
            console.log(
              "Navigation no intercept",
            );
            return;
          }

          e.intercept({
            focusReset: "manual",
            // deno-lint-ignore require-await
            async precommitHandler(controller) {
              try {
                if (shouldRedirect) {
                  controller.redirect(displayUrl.href);
                }
              } catch (err) {
                console.error("Error in pre-commit handler: ", err);
              }
            },

            async handler() {
              try {
                console.log(
                  "In navigation handler for fetchUrl: ",
                  fetchUrl.href,
                );
                const navigationMethod = fn.getNavigationMethod(e);
                const navigationApi = globalThis.navigation as AppNavigation;

                if (
                  navigationInfo?.onlyUpdateUrl ||
                  navigationApi.clientRouteBlockedEvents?.has(e)
                ) {
                  console.log(
                    "Navigation handled locally, no fetch performed.",
                  );
                  return;
                }

                if (e.sourceElement?.hasAttribute("data-local-only")) {
                  console.log(
                    "Navigation event is local only, no fetch performed.",
                  );
                  // We still may have activated client routes, or changed url
                  return;
                }

                console.log(
                  `NAV: Fetching from ${fetchUrl.href}, updating url to ${toUrl.href}`,
                );

                return await fn.performFetchAndUpdate(
                  fetchUrl,
                  fromUrl,
                  displayUrl,
                  e.formData,
                  navigationMethod,
                );
              } catch (err) {
                console.error("Error in navigation handler: ", err);
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
    };
  },
);

export const navigationTools = new Handlers(import.meta.url, async () => {
  const { fn } = await imports(
    navigationHandlerTools,
    applyNavigationHandlers,
  );
  return {
    handleNavigate: function (this: HTMLElement) {
      const navigationApi = globalThis.navigation as AppNavigation;
      if (!navigationApi.controller) {
        navigationApi.controller = new AbortController();
      }

      /** Tracks in-flight GET requests per pathname so rapid-fire calls abort stale ones. */
      navigationApi.inflightGetRequests = new Map<string, AbortController>();
      navigationApi.controller = new AbortController();

      globalThis.navigation.addEventListener(
        "navigate",
        fn.navigationHandler,
        {
          signal: navigationApi.controller.signal,
        },
      );
      console.log("Core navigation handler added: ", fn.navigationHandler);
    },
    abortNavigation: function (this: HTMLElement, _e: Event) {
      const navigationApi = globalThis.navigation as AppNavigation;
      navigationApi.controller?.abort();
      console.log("Aborted navigation");
    },
    setPathVariables: function (this: PartialAbortableHTMLElement) {
      console.log("setPathVariables activated, this: ", this);
      const html = globalThis.document
        .documentElement as PartialAbortableHTMLElement;
      const url = new URL(globalThis.location.href);
      url.pathname
        .split("/")
        .filter(Boolean)
        .forEach((part, i) => {
          html.style.setProperty(`--path-${i}`, part);
        });
      Array.from(url.searchParams.entries())
        .forEach(([key, value]) => {
          html.style.setProperty(`--param-${key}`, value);
        });

      // Dispatch to this element's own onCurrentEntryChange handlers.
      fn.applyCurrentEntryChangeListener.apply(this);
    },
    setVariablesFromUrl: function (event: NavigationCurrentEntryChangeEvent) {
      const fromUrl = new URL(event.from.url!);
      const toUrl = new URL(globalThis.location.href);

      const fromSplitPath = fromUrl.pathname.split("/").filter(Boolean);
      const toSplitPath = toUrl.pathname.split("/").filter(Boolean);
      toSplitPath.forEach((partPath, i) => {
        // Only update path variables if they have changed
        if (partPath !== fromSplitPath[i]) {
          document.documentElement.style.setProperty(
            `--path-${i}`,
            partPath,
          );
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
        if (!to) {
          document.documentElement.style.removeProperty(`--param-${key}`);
        } else {document.documentElement.style.setProperty(
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
      applyNavigationListener: function (
        this: PartialAbortableHTMLElement,
        _e: Event,
      ) {
        console.log("Applying navigation listener for element: ", this);
        globalThis.navigation.addEventListener("navigate", (event) => {
          const navigationInfo = event.info && typeof event.info === "object"
            ? event.info as NavigationClientInfo
            : null;
          if (
            !this.isConnected || event.defaultPrevented ||
            !event.canIntercept || navigationInfo?.onlyUpdateUrl
          ) return;
          const { shouldIntercept } = fn.getNavigationUrls(event);
          if (!shouldIntercept) return;
          tiny.runHandler(this, event);
        }, { signal: this.abortController?.signal });
      },
      applyCurrentEntryChangeListener: function (
        this: PartialAbortableHTMLElement,
      ) {
        console.log(
          "Applying current entry change listener for element: ",
          this,
        );
        globalThis.navigation.addEventListener(
          "currententrychange",
          (event) => {
            tiny.runHandler(this, event);
          },
          { signal: this.abortController?.signal },
        );
      },
    };
  },
);
