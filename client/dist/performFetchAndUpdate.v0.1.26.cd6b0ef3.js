import { processIncomingData } from "./processIncomingData.v0.1.9.45901526.js";
import { getActiveRouteCachePath } from "./routeCache.v0.1.24.4c2b30e3.js";
import { navigation } from "./navigationApi.v0.1.26.2ec47448.js";
const inflightGetRequests = /* @__PURE__ */ new Map();
async function performFetchAndUpdate(destinationUrl, fromUrl, toUrl, formData, requestMethod = formData ? "post" : "get", options = {}) {
  const method = requestMethod.toLowerCase() === "post" ? "post" : "get";
  console.log(
    `${method.toUpperCase()} Navigation to: ${destinationUrl.href}`
  );
  let signal;
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
  let response;
  try {
    response = await fetch(destinationUrl, {
      method,
      headers: {
        "partial-nav": "true",
        "source-url": fromUrl.pathname + fromUrl.search,
        "destination-url": toUrl.pathname + toUrl.search
      },
      body: method === "post" ? formData ?? void 0 : void 0,
      signal
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
  let activeRoutePathname = destinationUrl.pathname;
  let canonicalRoutePath = "";
  if (spaRedirect) {
    console.log("Found X-spa-redirect header, navigating to: ", spaRedirect);
    const redirectUrl = new URL(spaRedirect, toUrl.href);
    canonicalRoutePath = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
    activeRoutePathname = redirectUrl.pathname;
    navigation.navigate(
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
    navigation.navigate(
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
  if (method === "get") {
    inflightGetRequests.delete(destinationUrl.pathname);
  }
}
var stdin_default = performFetchAndUpdate;
export {
  stdin_default as default,
  performFetchAndUpdate
};
