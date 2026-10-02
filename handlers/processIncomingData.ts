import { Handlers, type PartialAbortableHTMLElement, tiny } from "../mod.ts";

/** Detail of the `incomingdata` event dispatched on `window` for each complete unit of incoming data. */
export type IncomingData =
  | {
    type: "html";
    element: HTMLElement;
    /** URLPattern pathnames from the update's `update-paths` attribute. */
    paths?: string[];
  }
  | { type: "json"; data: unknown };

export type IncomingDataEvent = CustomEvent<IncomingData>;

export const processIncomingDataTools = new Handlers(import.meta.url, {
  processIncomingData: async function (
    response: Response,
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
  /**
   * Forwards window `incomingdata` events to this element's own
   * `onIncomingData` handlers.
   */
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
  /**
   * Appends copies of the contents of incoming `<update>` elements to this
   * element. Partials in updates with paths are only applied when one of
   * them matches the current page path, or the `update-path` of a cacheable
   * region currently on the page (which may show content for a more
   * specific path than the URL, e.g. a default conversation on /messages).
   */
  appendIncomingHtml: function (this: HTMLElement, event: IncomingDataEvent) {
    if (event.detail.type !== "html") return;
    const { element, paths } = event.detail;
    const copy = element.cloneNode(true) as HTMLElement;
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
    if (!onMatchingPage) {
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
  /**
   * Applies the partials in incoming `<update>` elements to this router's
   * cached routes whose `update-path` matches one of the update's paths.
   */
  updateCachedRoutes: function (this: HTMLElement, event: IncomingDataEvent) {
    if (event.detail.type !== "html" || !event.detail.paths?.length) return;
    const { element, paths } = event.detail;
    const patterns = paths.map((pathname) => new URLPattern({ pathname }));
    const partials = Array.from(element.children).filter((child) =>
      child.tagName === "TEMPLATE" && child.hasAttribute("for-partial-id")
    );
    const routes = this.querySelector<HTMLTemplateElement>(":scope > template")
      ?.content;
    if (!partials.length || !routes) return;
    for (const route of Array.from(routes.children)) {
      const updatePath = route.getAttribute("update-path");
      if (
        !updatePath ||
        !patterns.some((pattern) => pattern.test({ pathname: updatePath }))
      ) continue;
      const cached = route.querySelector<HTMLTemplateElement>(
        "template[for-partial-id]",
      )?.content;
      if (!cached) continue;
      console.log("Applying update to cached route: ", updatePath);
      for (const partial of partials) {
        // Partials for elements outside this cached content (e.g. a list
        // elsewhere on the page) don't apply here.
        if (!cached.getElementById(partial.getAttribute("for-partial-id")!)) {
          continue;
        }
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
