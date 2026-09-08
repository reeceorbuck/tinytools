import { type ClientTools, Handlers } from "../clientTools.ts";
type RouteCacheFunctions = {
  registerRouteCache: (this: HTMLTemplateElement) => void;
};

export const routeCacheTools: ClientTools<
  RouteCacheFunctions,
  Record<never, never>,
  Record<never, never>
> = new Handlers(import.meta.url, {
  registerRouteCache: function (this: HTMLTemplateElement) {
    const partialId = this.getAttribute("for-partial-id");
    const path = this.getAttribute("path");
    const target = partialId ? document.getElementById(partialId) : null;
    const incomingRouter = this.content.querySelector("client-router");
    const incomingTemplate = incomingRouter?.querySelector<HTMLTemplateElement>(
      "abortable-lifecycle-element > template",
    );
    const route = this.content.querySelector("client-route");
    if (!target || !path || !incomingRouter || !incomingTemplate || !route) {
      this.remove();
      return;
    }
    const siblingRouter = Array.from(target.parentElement?.children ?? [])
      .find((element) => element.tagName === "CLIENT-ROUTER");
    const siblingTemplate = siblingRouter?.querySelector<HTMLTemplateElement>(
      "abortable-lifecycle-element > template",
    );
    if (siblingTemplate) {
      for (const existing of Array.from(siblingTemplate.content.children)) {
        if (
          existing.getAttribute("path") === route.getAttribute("path") &&
          existing.getAttribute("from-partial-id") === partialId
        ) existing.remove();
      }
      siblingTemplate.content.append(route);
    } else {
      incomingTemplate.content.append(route);
      target.insertAdjacentElement("afterend", incomingRouter);
    }
    for (const child of Array.from(target.children)) {
      if (child.matches("template[data-client-route-active-path]")) {
        child.remove();
      }
    }
    const marker = document.createElement("template");
    marker.setAttribute(
      "data-client-route-active-path",
      route.getAttribute("path")!,
    );
    target.append(marker);
    this.remove();
  },
});
