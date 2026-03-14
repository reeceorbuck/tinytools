import { processLocalSuspenseTemplates } from "./localRoutes.js";
import performFetchAndUpdate from "./performFetchAndUpdate.js";
globalThis.navigation.addEventListener(
  "navigate",
  async (e) => {
    try {
      const fromUrl = new URL(globalThis.location.href);
      const toUrl = new URL(e.destination.url);
      const fetchUrl = new URL(toUrl);
      if (e.sourceElement && e.sourceElement.hasAttribute("data-no-intercept") || toUrl.origin !== fromUrl.origin || e.info && e.info.blockIntercept) {
        console.log(
          "Navigation no intercept"
        );
        return;
      }
      console.log("e.sourceElement: ", e.sourceElement);
      const partialAttr = (e.sourceElement instanceof HTMLFormElement ? e.sourceElement : e.sourceElement && "form" in e.sourceElement ? e.sourceElement.form : null)?.getAttribute("data-nav-partial") ?? e.sourceElement?.getAttribute("data-nav-partial");
      console.log("Found data-nav-partial attribute: ", partialAttr);
      if (partialAttr) {
        fetchUrl.pathname = partialAttr;
        console.log("orginal destination url: ", e.destination.url);
      }
      console.log("New Navigation event: ", e);
      e.intercept({
        focusReset: "manual",
        // deno-lint-ignore require-await
        async precommitHandler(controller) {
          if (e.navigationType === "push") {
            try {
              let cleaned = false;
              const cleanUrl = new URL(toUrl);
              [...cleanUrl.searchParams].forEach(([key, value]) => {
                console.log("Checking param for cleaning: ", key, value);
                if (value === "") {
                  console.log("Removing empty param: ", key);
                  cleanUrl.searchParams.delete(key);
                  cleaned = true;
                }
              });
              if (cleaned) {
                console.log("Cleaned URL: ", cleanUrl.href);
                controller.redirect(cleanUrl.href);
                toUrl.pathname = cleanUrl.pathname;
              }
            } catch (err) {
              console.error("Error cleaning URL: ", err);
            }
            console.log(
              "In precommitHandler for navigation to: ",
              e.destination.url
            );
            console.log(
              "e.sourceElement: ",
              e.sourceElement?.form
            );
            try {
              const redirectAttr = (e.sourceElement instanceof HTMLFormElement ? e.sourceElement : e.sourceElement && "form" in e.sourceElement ? e.sourceElement.form : null)?.getAttribute("data-nav-redirect") ?? e.sourceElement?.getAttribute("data-nav-redirect");
              console.log("Found data-nav-redirect attribute: ", redirectAttr);
              if (redirectAttr === "true") {
                console.log(
                  "data-nav-redirect is true, keeping current URL in address bar"
                );
                controller.redirect(fromUrl.href);
              } else if (redirectAttr) {
                const displayUrl = new URL(
                  redirectAttr,
                  globalThis.location.href
                );
                console.log("redirecting to custom URL: ", displayUrl.href);
                controller.redirect(displayUrl.href);
                toUrl.pathname = displayUrl.pathname;
              } else {
                console.log(
                  "No data-nav-redirect attribute, proceeding with normal url update to: ",
                  toUrl.href
                );
              }
            } catch (err) {
              console.error("Error in pre-commit handler: ", err);
            }
          }
        },
        // deno-lint-ignore require-await
        async handler() {
          try {
            console.log("In navigation handler for fetchUrl: ", fetchUrl.href);
            if (e.info?.onlyUpdateUrl) {
              console.log(
                "Navigation event onlyUpdateUrl, no fetch performed."
              );
              return;
            }
            try {
              const block = processLocalSuspenseTemplates(
                fetchUrl,
                e.formData ?? null
              );
              if (block) {
                console.log(
                  "Blocking navigation for this local route due to template."
                );
                return;
              }
            } catch (err) {
              console.error("Error in processLocalSuspenseTemplates: ", err);
            }
            if (e.sourceElement?.hasAttribute("data-local-only")) {
              console.log(
                "Navigation event is local only, no fetch performed."
              );
              return;
            }
            console.log(
              `NAV: Fetching from ${fetchUrl.href}, updating url to ${toUrl.href}`
            );
            return performFetchAndUpdate(fetchUrl, fromUrl, toUrl, e.formData);
          } catch (err) {
            console.error("Error in navigation handler: ", err);
          }
        }
      });
    } catch (err) {
      console.error("Error handling navigation event: ", err);
      e.preventDefault();
    }
  }
);
