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
    const matchesBranch = (
      match: ReturnType<typeof compileClientRoute>,
      url: URL,
    ) => {
      const ancestorUrl = new URL(url);
      while (true) {
        if (match?.(ancestorUrl)) return true;
        const pathname = ancestorUrl.pathname.replace(/\/+$/, "");
        if (!pathname) return false;
        ancestorUrl.pathname = `${pathname}/`;
        if (match?.(ancestorUrl)) return true;
        ancestorUrl.pathname = pathname.slice(0, pathname.lastIndexOf("/")) ||
          "/";
      }
    };
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
        const fromMatch = compileClientRoute(
          route.getAttribute("from-path") ?? path,
          route.getAttribute("query"),
        );
        const partialId = route.getAttribute("from-partial-id");
        const target = partialId ? document.getElementById(partialId) : null;
        const active = Array.from(target?.children ?? []).some((child) =>
          child.getAttribute("data-client-route-active-path") === path
        );
        return [{ route, match, fromMatch, method, active }];
      });
    const updateRoutes = (
      fromUrl: URL,
      fetchUrl: URL,
      method: "get" | "post",
      event?: NavigateEvent,
    ) => {
      for (
        let ancestor = template.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const scope = Array.from(ancestor.children).find((child) =>
          child.hasAttribute("data-client-route-active-path")
        )?.getAttribute("data-client-route-active-path");
        if (
          scope && !matchesBranch(compileClientRoute(scope, null), fetchUrl)
        ) {
          return;
        }
      }
      const routes = getRoutes();
      const matchingRoutes = routes.flatMap(
        ({ route, match, method: routeMethod, active }) => {
          if (
            routeMethod !== method || active ||
            (!event && !route.hasAttribute("from-partial-id"))
          ) return [];
          if (
            !event && !route.querySelector<HTMLTemplateElement>(
              "template[for-partial-id]",
            )?.content.hasChildNodes()
          ) return [];
          const pathParams = match(fetchUrl);
          if (!pathParams) return [];
          const content = route.querySelector<HTMLTemplateElement>(
            "template[for-partial-id]",
          )?.content;
          for (
            const marker of content?.querySelectorAll(
              "template[data-client-route-active-path]",
            ) ?? []
          ) {
            const scope = marker.getAttribute("data-client-route-active-path")!;
            if (matchesBranch(compileClientRoute(scope, null), fetchUrl)) {
              continue;
            }
            const target = marker.parentElement;
            const parent = target?.parentNode as ParentNode | null;
            const router = Array.from(parent?.children ?? []).find((child) =>
              child.tagName === "CLIENT-ROUTER"
            )?.querySelector<HTMLTemplateElement>("template");
            const hasDestination = Array.from(router?.content.children ?? [])
              .some((child) =>
                child.getAttribute("from-partial-id") === target?.id &&
                (child.getAttribute("method") ?? "get").toLowerCase() ===
                  method &&
                compileClientRoute(
                  child.getAttribute("path") ?? "",
                  child.getAttribute("query"),
                )?.(fetchUrl) &&
                child.querySelector<HTMLTemplateElement>(
                  "template[for-partial-id]",
                )?.content.hasChildNodes()
              );
            if (!hasDestination) return [];
          }
          return [{ route, pathParams }];
        },
      );
      if (!event && !matchingRoutes.length) return;
      if (
        event &&
        (matchingRoutes.some(({ route }) =>
          route.hasAttribute("data-nav-block")
        ) ||
          (fromUrl.pathname === fetchUrl.pathname && routes.some(
            ({ route, match, method: routeMethod, active }) =>
              active && routeMethod === method && match(fetchUrl) &&
              route.hasAttribute("data-nav-block"),
          )))
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
      const capturedTargets = new Set<Element>();
      console.log("Matching routes:", matchingRoutes);
      console.log("Routes:", routes);
      for (const { route, fromMatch, match, active } of routes) {
        if (active && matchesBranch(match, fetchUrl)) continue;
        const partialId = route.getAttribute("from-partial-id");
        if (
          !partialId ||
          !(event
            ? active ? matchesBranch(fromMatch, fromUrl) : fromMatch?.(fromUrl)
            : active)
        ) continue;
        const target = document.getElementById(partialId);
        const insertion = route.querySelector<HTMLTemplateElement>(
          "template[for-partial-id]",
        );
        if (!target || !insertion || capturedTargets.has(target)) continue;
        const activePath = Array.from(target.children).find((child) =>
          child.matches("template[data-client-route-active-path]")
        )?.getAttribute("data-client-route-active-path");
        if (
          activePath !== undefined &&
          activePath !== route.getAttribute("path")
        ) continue;
        capturedTargets.add(target);
        insertion.content.replaceChildren(...Array.from(target.childNodes));
      }
      if (!matchingRoutes.length) return;
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
      if (event) {
        event.intercept({ focusReset: "manual", handler: render });
      } else {
        render();
      }
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
        const { fromUrl, fetchUrl, shouldIntercept } = getNavigationUrls(event);
        if (!shouldIntercept) return;
        updateRoutes(fromUrl, fetchUrl, getNavigationMethod(event), event);
      }, { signal: this.abortController.signal });
    }
    const currentUrl = new URL(globalThis.location.href);
    updateRoutes(currentUrl, currentUrl, "get");
  },
  suspendClientRoutes: function (this: PartialAbortableHTMLElement, _e: Event) {
    this.abortController?.abort();
    console.log("No longer tracking navigation for: ", this);
  },
});

export async function ClientRoutes(
  props: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(ClientRouterHandlers);
  return (
    <client-router hidden>
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
