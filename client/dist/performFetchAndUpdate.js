import { processIncomingData } from "./processIncomingData.js";
async function performFetchAndUpdate(destinationUrl, fromUrl, toUrl, formData) {
  console.log(
    `${formData ? "POST" : "GET"} Navigation to: ${destinationUrl.href}`
  );
  const response = await fetch(destinationUrl, {
    method: formData ? "post" : "get",
    headers: {
      "partial-nav": "true",
      "source-url": fromUrl.pathname + fromUrl.search,
      "destination-url": toUrl.pathname + toUrl.search
    },
    body: formData ? formData : void 0
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
  processIncomingData(response);
}
var stdin_default = performFetchAndUpdate;
export {
  stdin_default as default,
  performFetchAndUpdate
};
