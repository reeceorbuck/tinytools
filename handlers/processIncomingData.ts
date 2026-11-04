import {
  type Handlers,
  type PartialAbortableHTMLElement,
  tiny,
} from "../mod.ts";
import { sourcedCollections } from "../clientTools.ts";

const sourced = sourcedCollections(import.meta.url);

/** Why a response is late: see `IncomingData`. */
export type Superseded = "page" | "background";

/** Detail of the `incomingdata` event dispatched on `window` for each complete unit of incoming data. */
export type IncomingData =
  | {
    type: "html";
    element: HTMLElement;
    /** URLPattern pathnames from the update's `update-paths` attribute. */
    paths?: string[];
    /**
     * The user has left the page that made this request. `page`: it was to
     * show a page, so only what can be cached is kept. `background`: it didn't
     * change the path, so its partials still apply.
     */
    superseded?: Superseded;
  }
  | { type: "json"; data: unknown };

/** The `incomingdata` event, as received by `onIncomingData` handlers. */
export type IncomingDataEvent = CustomEvent<IncomingData>;

/**
 * Applies server responses and pushed updates to the page. Each response is
 * split into units of incoming data, dispatched on `window` as `incomingdata`
 * events; elements receive them through `onIncomingData` once
 * `applyIncomingDataListener` is bound to their `onLoad`, e.g.
 * `<body onLoad={fn.applyIncomingDataListener}
 * onIncomingData={fn.appendIncomingHtml}>`.
 */
export const processIncomingDataTools: Handlers<{
  /**
   * Reads a response, streaming as it arrives, and dispatches an
   * `incomingdata` event for each complete `<update>` element, or once for a
   * JSON body. Other HTML is shown in the page's `#global-modal` dialog.
   * `superseded` says, per update, if the user has left the requesting page.
   */
  processIncomingData(
    response: Response,
    superseded?: () => Superseded | undefined,
  ): Promise<void>;
  /**
   * Forwards window `incomingdata` events to this element's own
   * `onIncomingData` handlers.
   */
  applyIncomingDataListener(
    this: PartialAbortableHTMLElement | typeof globalThis,
  ): void;
  /**
   * Appends copies of the contents of incoming `<update>` elements to this
   * element. Partials in updates with paths are only applied when one of
   * them matches the current page path, or the `update-path` of a cacheable
   * region currently on the page (which may show content for a more
   * specific path than the URL, e.g. a default conversation on /messages).
   * Applied partials are marked `optional-target`, as an update can target an
   * element that isn't on this page. A superseded update files its cacheable
   * partials as cached routes and leaves the page and its title alone; one
   * for a page with nothing to cache is discarded.
   */
  appendIncomingHtml(this: HTMLElement, event: IncomingDataEvent): void;
  /**
   * Applies the partials in incoming `<update>` elements to this router's
   * cached routes whose `update-path` matches one of the update's paths, and
   * streamed Suspense content to the cached route holding its fallback.
   */
  updateCachedRoutes(this: HTMLElement, event: IncomingDataEvent): void;
}> = new sourced.Handlers({
  processIncomingData: async function (
    response: Response,
    superseded?: () => Superseded | undefined,
  ) {
    const contentType = response.headers.get("Content-Type") || "";

    const dispatch = (detail: IncomingData) => {
      globalThis.dispatchEvent(
        new CustomEvent<IncomingData>("incomingdata", { detail }),
      );
    };

    if (response.body === null) {
      console.warn("Empty response body, status:", response.status);
      return;
    }

    if (contentType.startsWith("application/json")) {
      try {
        dispatch({ type: "json", data: await response.json() });
      } catch (err) {
        console.error("Failed to parse JSON response:", err);
      }
      return;
    }

    if (!contentType.startsWith("text/html")) {
      console.warn(
        `Unhandled Content-Type "${contentType}", response status: `,
        response.status,
      );
      return;
    }

    // Use a streaming TextDecoder to avoid splitting multibyte chars across chunks
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      if (text.length === 0) continue;
      buffer += text;

      // Try to parse and process only when we have a valid HTML fragment
      if (buffer.includes("</update>")) {
        // Split buffer to handle multiple <update> tags that may arrive together
        const updates = buffer.split("</update>");
        // Last element is either empty or incomplete - keep it in buffer
        buffer = updates.pop() || "";

        for (const updateContent of updates) {
          if (!updateContent.trim()) continue;

          const fullUpdate = updateContent + "</update>";

          const updateFragment = globalThis.document.createRange()
            .createContextualFragment(fullUpdate);
          const updateElement = updateFragment.querySelector("update");
          if (!updateElement) {
            console.warn("Skipping malformed update:", fullUpdate);
            continue;
          }
          let paths: string[] | undefined;
          try {
            paths = JSON.parse(
              updateElement.getAttribute("update-paths") ?? "null",
            ) ?? undefined;
          } catch (err) {
            console.error("Invalid update-paths attribute:", err);
          }
          dispatch({
            type: "html",
            element: updateElement as HTMLElement,
            paths,
            superseded: superseded?.(),
          });
        }
      } else if (
        buffer.startsWith("<!DOCTYPE html><update") ||
        buffer.startsWith("<update")
      ) {
        // Incomplete update, wait for the next chunk.
      } else {
        // Not a partial: show the HTML in the page's global modal, if any.
        console.warn("Non-update HTML response:", buffer);
        const popupDialog = document.getElementById("global-modal") as
          | HTMLDialogElement
          | null;
        if (typeof popupDialog?.showModal === "function") {
          const fragment = globalThis.document.createRange()
            .createContextualFragment(buffer);
          popupDialog.replaceChildren(...Array.from(fragment.children));
          popupDialog.showModal();
        }
        buffer = "";
      }
    }
    if (buffer.trim()) {
      console.warn("Stream ended with an incomplete update:", buffer);
    }
  },
  applyIncomingDataListener: function (
    this: PartialAbortableHTMLElement | typeof globalThis,
  ) {
    // <body onLoad> runs with `this === window`, so resolve to the body.
    const element = this === globalThis
      ? document.body as PartialAbortableHTMLElement
      : this as PartialAbortableHTMLElement;
    globalThis.addEventListener(
      "incomingdata",
      (event) => {
        tiny.runHandler(element, event);
      },
      { signal: element.abortController?.signal },
    );
  },
  appendIncomingHtml: function (this: HTMLElement, event: IncomingDataEvent) {
    if (event.detail.type !== "html") return;
    const { element, paths, superseded } = event.detail;
    const copy = element.cloneNode(true) as HTMLElement;
    if (superseded) {
      // A response's head and body sit in wrapper templates, a level above
      // its partials.
      const wrappers = Array.from(copy.children).filter((child) =>
        child.tagName === "TEMPLATE" && !child.hasAttribute("for-partial-id")
      ) as HTMLTemplateElement[];
      const dropPartial = (partial: Element) => {
        const trigger = partial.nextElementSibling;
        if (trigger?.tagName === "LINK") trigger.remove();
        partial.remove();
      };
      let title: string | null = null;
      let filed = false;
      const uncached: Element[] = [];
      for (
        const child of wrappers.flatMap((w) => Array.from(w.content.children))
      ) {
        if (child.tagName === "TITLE") {
          title = child.textContent;
          child.remove();
        }
        if (child.tagName !== "TEMPLATE") continue;
        const partial = child as HTMLTemplateElement;
        const collector = Array.from(partial.content.children).find((node) =>
          node.tagName === "CACHE-COLLECTOR"
        );
        if (!collector) {
          uncached.push(partial);
          continue;
        }
        filed = true;
        const partialId = partial.getAttribute("for-partial-id")!;
        const target = document.getElementById(partialId);
        const parts = collector.querySelector("template")?.content;
        const blueprint = parts?.querySelector("client-route");
        const route = blueprint?.cloneNode(true) as Element | undefined;
        let router = Array.from(target?.parentElement?.children ?? []).find(
          (element) =>
            element.tagName === "CLIENT-ROUTER" &&
            element.getAttribute("cache-owner-id") === partialId,
        );
        if (!router && target) {
          router = parts?.querySelector("client-router") ?? undefined;
          if (router) target.insertAdjacentElement("afterend", router);
        }
        const routes = router?.querySelector("template")?.content;
        if (route && routes) {
          route.querySelector<HTMLTemplateElement>("template[for-partial-id]")!
            .content.append(...Array.from(partial.content.childNodes));
          if (title !== null) route.setAttribute("route-title", title);
          for (const existing of Array.from(routes.children)) {
            if (existing.getAttribute("path") === route.getAttribute("path")) {
              existing.remove();
            }
          }
          routes.append(route);
        }
        dropPartial(partial);
      }
      // Partials beside a cached one (a list row) belong to the whole page.
      if (superseded === "page" && !filed) uncached.forEach(dropPartial);
    }
    const livePaths = [location.pathname];
    for (const collector of document.querySelectorAll("cache-collector")) {
      const updatePath = collector.querySelector("template")?.content
        .querySelector("client-route")?.getAttribute("update-path");
      if (updatePath) livePaths.push(updatePath);
    }
    const onMatchingPage = !paths ||
      paths.some((pathname) => {
        const pattern = new URLPattern({ pathname });
        return livePaths.some((path) => pattern.test({ pathname: path }));
      });
    if (onMatchingPage) {
      // Pushed updates may target content this page doesn't show.
      for (
        const partial of copy.querySelectorAll(
          ":scope > template[for-partial-id]",
        )
      ) {
        partial.setAttribute("optional-target", "");
      }
    } else {
      // Keep head imports, drop partials (and their load-trigger links).
      for (const child of Array.from(copy.children)) {
        if (
          child.tagName !== "TEMPLATE" || !child.hasAttribute("for-partial-id")
        ) continue;
        const trigger = child.nextElementSibling;
        if (trigger?.tagName === "LINK") trigger.remove();
        child.remove();
      }
    }
    this.append(...Array.from(copy.childNodes));
  },
  updateCachedRoutes: function (this: HTMLElement, event: IncomingDataEvent) {
    if (event.detail.type !== "html") return;
    const { element, paths = [] } = event.detail;
    const patterns = paths.map((pathname) => new URLPattern({ pathname }));
    const partials = Array.from(element.children).filter((child) =>
      child.tagName === "TEMPLATE" && child.hasAttribute("for-partial-id")
    );
    const routes = this.querySelector<HTMLTemplateElement>(":scope > template")
      ?.content;
    if (!partials.length || !routes) return;
    for (const route of Array.from(routes.children)) {
      const updatePath = route.getAttribute("update-path");
      const pathMatches = !!updatePath &&
        patterns.some((pattern) => pattern.test({ pathname: updatePath }));
      const cached = route.querySelector<HTMLTemplateElement>(
        "template[for-partial-id]",
      )?.content;
      if (!cached) continue;
      for (const partial of partials) {
        const partialId = partial.getAttribute("for-partial-id")!;
        // Suspense content finishes the view that was left mid-load.
        if (!pathMatches && !partialId.startsWith("suspended-")) continue;
        // Partials for elements outside this cached content (e.g. a list
        // elsewhere on the page) don't apply here.
        if (!cached.getElementById(partialId)) continue;
        console.log(
          "Applying update to cached route: ",
          route.getAttribute("path"),
        );
        // Partial insert handlers resolve their target within updateRoot.
        const copy = Object.assign(
          partial.cloneNode(true) as HTMLTemplateElement,
          { updateRoot: cached },
        );
        copy.dispatchEvent(new Event("load"));
      }
    }
  },
});
