/**
 * Navigation client script for @tinytools/hono-tools
 *
 * Intercepts browser navigation events and performs partial page updates.
 */

import { processLocalSuspenseTemplates } from "./localRoutes.ts";
import performFetchAndUpdate from "./performFetchAndUpdate.ts";

globalThis.navigation.addEventListener(
  "navigate",
  async (e) => {
    try {
      const fromUrl = new URL(globalThis.location.href);
      const toUrl = new URL(e.destination.url);
      const fetchUrl = new URL(toUrl);

      // If info has blockIntercept, don't intercept
      // If different origin, dont intercept, just let it happen
      // If a tag contains an attribute data-no-intercept, don't intercept
      if (
        (e.sourceElement &&
          e.sourceElement.hasAttribute("data-no-intercept")) ||
        toUrl.origin !== fromUrl.origin ||
        (e.info && e.info.blockIntercept)
      ) {
        console.log(
          "Navigation no intercept",
        );
        // This return means there will be a full page navigation, instead of intercepting
        return;
      }

      console.log("e.sourceElement: ", e.sourceElement);

      const partialAttr = (e.sourceElement instanceof HTMLFormElement
        ? e.sourceElement
        : e.sourceElement && "form" in e.sourceElement
        ? (e.sourceElement as HTMLInputElement | HTMLButtonElement).form
        : null)?.getAttribute("data-nav-partial") ??
        e.sourceElement?.getAttribute("data-nav-partial");
      console.log("Found data-nav-partial attribute: ", partialAttr);

      if (partialAttr) {
        // Then actually navigate to the partial url
        // const partialPath = e.sourceElement.getAttribute("data-nav-partial");
        // console.log("Navigating to partial path: ", partialPath);
        // if (!partialPath) {
        //   throw new Error("data-nav-partial has no value");
        // }
        fetchUrl.pathname = partialAttr;
        console.log("orginal destination url: ", e.destination.url);
      }
      console.log("New Navigation event: ", e);

      // if (
      //   e.formData ||
      //   e.sourceElement instanceof HTMLFormElement ||
      //   (e.sourceElement && "form" in e.sourceElement)
      // ) {
      //   const form = e.sourceElement as HTMLFormElement;
      //   if (form.hasAttribute("data-update-url")) {
      //     console.log(
      //       "Navigation event is a form submission, but has data-update-url, so intercept with url update",
      //     );
      //   } else {
      //     e.preventDefault();
      //     console.log(
      //       "Navigation event prevented due to form submission, ie. fetch but no url or query param change: ",
      //       e,
      //     );
      //     await performFetchAndUpdate(toUrl, fromUrl, e.formData);
      //     return;
      //   }
      // }

      e.intercept({
        focusReset: "manual",
        // deno-lint-ignore require-await
        async precommitHandler(controller) {
          if (e.navigationType === "push") {
            // This is where we can modify the URL in the address bar, to either keep as is for a POST form submission,
            // or to clean up additional get query params that were only needed for the fetch

            // We are going to preserve the query params as state
            // const currentParams = fromUrl.searchParams;

            // console.log(
            //   "toUrl params before cleaning: ",
            //   toUrl.searchParams.toString(),
            // );

            // currentParams.forEach((value, key) => {
            //   if (toUrl.searchParams.get(key) === null) {
            //     toUrl.searchParams.set(key, value);
            //   }
            // });
            // Dont clean if its a partial navigation

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

            // Should be an attribute on the form, or the link, to indicate what to do here
            console.log(
              "In precommitHandler for navigation to: ",
              e.destination.url,
            );
            console.log(
              "e.sourceElement: ",
              (e.sourceElement as HTMLButtonElement)?.form,
            );
            try {
              const redirectAttr = (e.sourceElement instanceof HTMLFormElement
                ? e.sourceElement
                : e.sourceElement && "form" in e.sourceElement
                ? (e.sourceElement as HTMLInputElement | HTMLButtonElement).form
                : null)?.getAttribute("data-nav-redirect") ??
                e.sourceElement?.getAttribute("data-nav-redirect");
              console.log("Found data-nav-redirect attribute: ", redirectAttr);
              if (redirectAttr === "true") {
                console.log(
                  "data-nav-redirect is true, keeping current URL in address bar",
                );
                controller.redirect(fromUrl.href);
              } else if (redirectAttr) {
                const displayUrl = new URL(
                  redirectAttr,
                  globalThis.location.href,
                );
                // displayUrl.searchParams.delete("date_input"); <-- example of deleting a query param after use
                console.log("redirecting to custom URL: ", displayUrl.href);
                controller.redirect(displayUrl.href);
                toUrl.pathname = displayUrl.pathname;
              } else {
                console.log(
                  "No data-nav-redirect attribute, proceeding with normal url update to: ",
                  toUrl.href,
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
                "Navigation event onlyUpdateUrl, no fetch performed.",
              );
              return;
            }

            try {
              const block = processLocalSuspenseTemplates(
                fetchUrl,
                e.formData ?? null,
              );
              if (block) {
                console.log(
                  "Blocking navigation for this local route due to template.",
                );
                return;
              }
            } catch (err) {
              console.error("Error in processLocalSuspenseTemplates: ", err);
            }

            if (e.sourceElement?.hasAttribute("data-local-only")) {
              console.log(
                "Navigation event is local only, no fetch performed.",
              );
              return;
            }

            console.log(
              `NAV: Fetching from ${fetchUrl.href}, updating url to ${toUrl.href}`,
            );

            return performFetchAndUpdate(fetchUrl, fromUrl, toUrl, e.formData);
          } catch (err) {
            console.error("Error in navigation handler: ", err);
          }
        },
      });
    } catch (err) {
      console.error("Error handling navigation event: ", err);
      e.preventDefault();
    }
  },
);
