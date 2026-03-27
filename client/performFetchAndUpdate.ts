/**
 * Fetch and Update client script for @tinytools/hono-tools
 *
 * Performs fetch requests and processes incoming HTML responses.
 */

import { processIncomingData } from "./processIncomingData.ts";

export async function performFetchAndUpdate(
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
  const response = await fetch(destinationUrl, {
    method,
    headers: {
      "partial-nav": "true",
      "source-url": fromUrl.pathname + fromUrl.search,
      "destination-url": toUrl.pathname + toUrl.search,
    },
    body: method === "post" ? formData ?? undefined : undefined,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const spaRedirect = response.headers.get("X-spa-redirect");
  let activeRoutePathname = toUrl.pathname;
  let canonicalRoutePath = "";
  if (spaRedirect) {
    console.log("Found X-spa-redirect header, navigating to: ", spaRedirect);
    // Canonicalize cache key to the redirected display URL path.
    const redirectUrl = new URL(spaRedirect, toUrl.href);
    canonicalRoutePath = redirectUrl.pathname + redirectUrl.search +
      redirectUrl.hash;
    activeRoutePathname = redirectUrl.pathname;
    globalThis.navigation.navigate(
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
    globalThis.navigation.navigate(
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

  const activeRouteRegistrations = method === "get"
    ? [
      canonicalRoutePath && canonicalRoutePath !== toUrl.pathname
        ? {
          pathname: toUrl.pathname,
          redirectTo: canonicalRoutePath,
        }
        : {
          pathname: toUrl.pathname,
        },
      canonicalRoutePath && canonicalRoutePath !== toUrl.pathname
        ? {
          pathname: activeRoutePathname,
        }
        : null,
    ].filter((entry): entry is { pathname: string; redirectTo?: string } =>
      entry !== null
    )
    : undefined;

  processIncomingData(response, {
    cacheCurrentPath: method === "get" ? fromUrl.pathname : undefined,
    activeRoutePath: method === "get" ? activeRoutePathname : undefined,
    activeRouteRegistrations,
  });
}

export default performFetchAndUpdate;
