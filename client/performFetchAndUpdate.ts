/**
 * Fetch and Update client script for @tinytools/hono-tools
 *
 * Performs fetch requests and processes incoming HTML responses.
 */

import { processIncomingData } from "./processIncomingData.ts";
import { beginRouteSnapshot } from "./routeCache.ts";

export async function performFetchAndUpdate(
  destinationUrl: URL,
  fromUrl: URL,
  toUrl: URL,
  formData?: FormData | null,
) {
  console.log(
    `${formData ? "POST" : "GET"} Navigation to: ${destinationUrl.href}`,
  );
  const response = await fetch(destinationUrl, {
    method: formData ? "post" : "get",
    headers: {
      "partial-nav": "true",
      "source-url": fromUrl.pathname + fromUrl.search,
      "destination-url": toUrl.pathname + toUrl.search,
    },
    body: formData ? formData : undefined,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const spaRedirect = response.headers.get("X-spa-redirect");
  if (spaRedirect) {
    console.log("Found X-spa-redirect header, navigating to: ", spaRedirect);
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
  if (!formData) {
    beginRouteSnapshot(fromUrl.pathname);
  }

  processIncomingData(response, {
    cacheCurrentPath: !formData ? fromUrl.pathname : undefined,
  });
}

export default performFetchAndUpdate;
