import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { UpgradeCustomElement } from "./ActivateOnLoadHandler.tsx";
import { type PartialAbortableHTMLElement, tiny } from "../mod.ts";
import { Handlers, imports } from "../clientTools.ts";
import {
  applyNavigationHandlers,
  type AppNavigation,
} from "../handlers/navigationTools.ts";
import { navigationUrlTools } from "../handlers/navigationUrlTools.ts";
import { clientRouteTools } from "../handlers/clientRouteTools.ts";
import { transparent } from "../componentScope.ts";

const ClientRouterHandlers = new Handlers(import.meta.url, async () => {
  const { fn } = await imports(navigationUrlTools, clientRouteTools);
  return {
    matchClientRoutes: function (
      this: PartialAbortableHTMLElement,
      event: NavigateEvent,
    ) {
      const navigationApi = globalThis.navigation as AppNavigation;
      navigationApi.clientRouteBlockedEvents ??= new WeakSet<NavigateEvent>();
      const template = this.querySelector(
        "template",
      ) as unknown as HTMLTemplateElement;

      const method = fn.getNavigationMethod(event);
      const { fetchUrl, fromUrl } = fn.getNavigationUrls(event);

      console.log("Template check: ", template);

      const routes = [...template.content.children].flatMap((route) => {
        if (route.tagName !== "CLIENT-ROUTE") return [];
        const path = route.getAttribute("path");
        if (!path) return [];
        const match = fn.compileClientRoute(
          path,
          route.getAttribute("query"),
        );
        if (!match) {
          console.warn("Invalid client route pattern:", route);
          return [];
        }
        const method = (route.getAttribute("method") || "get").toLowerCase();
        return [{ route, match, method }];
      });

      console.log("Found Routes check: ", routes);

      const matchingRoutes = routes.flatMap(
        ({ route, match, method: routeMethod }) => {
          if (routeMethod !== method) return [];
          const pathParams = match(fetchUrl);
          if (!pathParams) return [];
          return [{ route, pathParams }];
        },
      );

      console.log("Matching Routes check: ", matchingRoutes);

      if (!matchingRoutes.length) return;
      if (
        matchingRoutes.some(({ route }) => route.hasAttribute("data-nav-block"))
      ) {
        console.log("Blocking navigation event due to local client route");
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

      // A matched route's data-nav-redirect keeps (or sets) the displayed URL,
      // like the attribute on a link or form. Without it the destination URL
      // is committed, and the next navigation starts from that URL.
      const redirect = matchingRoutes
        .map(({ route }) => route.getAttribute("data-nav-redirect"))
        .find((value) => value !== null);
      let redirectUrl: string | undefined;
      if (redirect !== undefined && event.navigationType === "push") {
        try {
          redirectUrl = redirect === "" || redirect === "true"
            ? fromUrl.href
            : new URL(redirect, fromUrl.href).href;
        } catch (error) {
          console.error(
            "Error parsing client route data-nav-redirect: ",
            error,
          );
        }
      }

      event.intercept({
        focusReset: "manual",
        ...(redirectUrl
          ? {
            precommitHandler(controller: NavigationPrecommitController) {
              controller.redirect(redirectUrl);
            },
          }
          : {}),
        handler: () => {
          if (event?.defaultPrevented || event?.signal?.aborted) {
            return Promise.resolve();
          }
          for (const { route, pathParams } of matchingRoutes) {
            if (
              event && navigationApi.clientRouteBlockedEvents?.has(event) &&
              route.hasAttribute("fallback")
            ) continue;
            document.body.append(fn.cloneClientRoute(route, {
              ...pathParams,
              ...queryParams,
              ...formParams,
            }));
          }
          return Promise.resolve();
        },
      });
    },
  };
});

async function renderClientRoutes(
  props: PropsWithChildren<{ cacheOwnerId?: string }>,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(
    ClientRouterHandlers,
    applyNavigationHandlers,
  );
  return (
    <UpgradeCustomElement>
      <client-router
        onLoad={fn.applyNavigationListener}
        onNavigate={fn.matchClientRoutes}
        hidden
        cache-owner-id={props.cacheOwnerId}
      >
        <template>
          {props.children}
        </template>
      </client-router>
    </UpgradeCustomElement>
  );
}

export function ClientRoutes(
  props: PropsWithChildren,
): Promise<HtmlEscapedString> {
  return renderClientRoutes(props);
}

export function PartialCacheRoutes(
  props: { ownerId?: string },
): Promise<HtmlEscapedString> {
  return renderClientRoutes({ cacheOwnerId: props.ownerId });
}

// Framework wrappers render into the caller's component scope.
transparent(ClientRoutes);
transparent(PartialCacheRoutes);
