import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { ActivateLifecycleHandlers } from "./ActivateOnLoadHandler.tsx";
import { type PartialAbortableHTMLElement, tiny } from "../mod.ts";
import { Handlers } from "../clientTools.ts";
import type {
  AppNavigation,
  NavigationClientInfo,
} from "../handlers/navigationTools.ts";
import {
  getNavigationMethod,
  getNavigationUrls,
  navigationUrlTools,
} from "../handlers/navigationUrlTools.ts";
import {
  clientRouteTools,
  cloneClientRoute,
  compileClientRoute,
} from "../handlers/clientRouteTools.ts";

const ClientRouterHandlers = new Handlers(import.meta.url, {
  imports: [navigationUrlTools, clientRouteTools],
}, {
  activateClientRoutes: function (
    this: PartialAbortableHTMLElement,
    _e: Event,
  ) {
    const navigationApi = globalThis.navigation as AppNavigation;
    navigationApi.clientRouteBlockedEvents ??= new WeakSet<NavigateEvent>();
    const template = this as unknown as HTMLTemplateElement;
    const getRoutes = () =>
      [...template.content.children].flatMap((route) => {
        if (route.tagName !== "CLIENT-ROUTE") return [];
        const path = route.getAttribute("path");
        if (!path) return [];
        const match = compileClientRoute(path, route.getAttribute("query"));
        if (!match) {
          console.warn("Invalid client route pattern:", route);
          return [];
        }
        const method = (route.getAttribute("method") || "get").toLowerCase();
        return [{ route, match, method }];
      });
    const updateRoutes = (
      fetchUrl: URL,
      method: "get" | "post",
      event: NavigateEvent,
    ) => {
      const routes = getRoutes();
      const matchingRoutes = routes.flatMap(
        ({ route, match, method: routeMethod }) => {
          if (routeMethod !== method) return [];
          const pathParams = match(fetchUrl);
          if (!pathParams) return [];
          return [{ route, pathParams }];
        },
      );
      if (!matchingRoutes.length) return;
      if (
        matchingRoutes.some(({ route }) => route.hasAttribute("data-nav-block"))
      ) {
        navigationApi.clientRouteBlockedEvents!.add(event);
      }
      const queryParams: Record<string, string> = Object.create(null);
      if (matchingRoutes.length) {
        for (const [key, value] of fetchUrl.searchParams) {
          if (!Object.hasOwn(queryParams, key)) queryParams[key] = value;
        }
      }
      const formParams: Record<string, string> = Object.create(null);
      if (matchingRoutes.length && method === "post" && event?.formData) {
        for (const [key, value] of event.formData) {
          if (!Object.hasOwn(formParams, key)) {
            formParams[key] = value.toString();
          }
        }
      }
      console.log("Matching routes:", matchingRoutes);
      console.log("Routes:", routes);
      const render = () => {
        if (event?.defaultPrevented || event?.signal?.aborted) {
          return Promise.resolve();
        }
        for (const { route, pathParams } of matchingRoutes) {
          if (
            event && navigationApi.clientRouteBlockedEvents?.has(event) &&
            route.hasAttribute("fallback")
          ) continue;
          document.body.append(cloneClientRoute(route, {
            ...pathParams,
            ...queryParams,
            ...formParams,
          }));
        }
        return Promise.resolve();
      };
      event.intercept({ focusReset: "manual", handler: render });
    };
    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController();
      globalThis.navigation.addEventListener("navigate", (event) => {
        const navigationInfo = event.info && typeof event.info === "object"
          ? event.info as NavigationClientInfo
          : null;
        if (
          !template.isConnected || event.defaultPrevented ||
          !event.canIntercept || navigationInfo?.onlyUpdateUrl
        ) return;
        const { fetchUrl, shouldIntercept } = getNavigationUrls(event);
        if (!shouldIntercept) return;
        updateRoutes(fetchUrl, getNavigationMethod(event), event);
      }, { signal: this.abortController.signal });
    }
  },
  suspendClientRoutes: function (this: PartialAbortableHTMLElement, _e: Event) {
    this.abortController?.abort();
    console.log("No longer tracking navigation for: ", this);
  },
});

export async function ClientRoutes(
  props: PropsWithChildren<{ "for-partial-id"?: string }>,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(ClientRouterHandlers);
  return (
    <client-router hidden for-partial-id={props["for-partial-id"]}>
      <ActivateLifecycleHandlers>
        <template
          onLoad={fn.activateClientRoutes}
          onSuspend={fn.suspendClientRoutes}
        >
          {props.children}
        </template>
      </ActivateLifecycleHandlers>
    </client-router>
  );
}
