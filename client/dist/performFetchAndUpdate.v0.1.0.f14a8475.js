import { processIncomingData } from "./processIncomingData.v0.1.0.f14a8475.js";
import { getActiveRouteCachePath } from "./routeCache.v0.1.0.f14a8475.js";
async function performFetchAndUpdate(destinationUrl, fromUrl, toUrl, formData, requestMethod = formData ? "post" : "get", options = {}) {
  const method = requestMethod.toLowerCase() === "post" ? "post" : "get";
  console.log(
    `${method.toUpperCase()} Navigation to: ${destinationUrl.href}`
  );
  const response = await fetch(destinationUrl, {
    method,
    headers: {
      "partial-nav": "true",
      "source-url": fromUrl.pathname + fromUrl.search,
      "destination-url": toUrl.pathname + toUrl.search
    },
    body: method === "post" ? formData ?? void 0 : void 0
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const spaRedirect = response.headers.get("X-spa-redirect");
  let activeRoutePathname = destinationUrl.pathname;
  let canonicalRoutePath = "";
  if (spaRedirect) {
    console.log("Found X-spa-redirect header, navigating to: ", spaRedirect);
    const redirectUrl = new URL(spaRedirect, toUrl.href);
    canonicalRoutePath = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
    activeRoutePathname = redirectUrl.pathname;
    globalThis.navigation.navigate(
      spaRedirect,
      {
        history: "replace",
        info: {
          onlyUpdateUrl: true
        }
      }
    );
  }
  if (response.redirected) {
    const redirectedUrl = new URL(response.url);
    console.log("Redirected to: ", redirectedUrl);
    globalThis.navigation.navigate(
      redirectedUrl.href,
      {
        history: "replace",
        info: {
          blockIntercept: true
        }
      }
    );
    return;
  }
  const activeRouteRegistrations = method === "get" ? [
    canonicalRoutePath && canonicalRoutePath !== destinationUrl.pathname ? {
      pathname: destinationUrl.pathname,
      redirectTo: canonicalRoutePath
    } : {
      pathname: destinationUrl.pathname
    },
    canonicalRoutePath && canonicalRoutePath !== destinationUrl.pathname ? {
      pathname: activeRoutePathname
    } : null
  ].filter(
    (entry) => entry !== null
  ) : void 0;
  processIncomingData(response, {
    cacheCurrentPath: method === "get" && !options.bypassRouteCache ? getActiveRouteCachePath(fromUrl.pathname) : void 0,
    activeRoutePath: method === "get" && !options.bypassRouteCache ? activeRoutePathname : void 0,
    activeRouteRegistrations: options.bypassRouteCache ? void 0 : activeRouteRegistrations,
    bypassRouteCache: options.bypassRouteCache,
    navGeneration: options.navGeneration
  });
}
var stdin_default = performFetchAndUpdate;
export {
  stdin_default as default,
  performFetchAndUpdate
};
