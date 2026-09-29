import { Handlers } from "../clientTools.ts";

type CacheObserverElement = HTMLTemplateElement & {
  stopCacheObserver?: () => void;
  abortController?: AbortController;
};

export const routeCacheTools = new Handlers(import.meta.url, {
  observeRouteCache: function (this: CacheObserverElement) {
    if (this.stopCacheObserver || !this.isConnected) return;
    const partialId = this.getAttribute("cache-partial-id");
    const target = partialId ? document.getElementById(partialId) : null;
    const template = this.querySelector("template");
    if (!target || !template) {
      console.error("No target element or template found for cache observer.");
      return;
    }
    const blueprint = template.content.querySelector(
      "client-route",
    );
    console.log("Cache blueprint: ", blueprint);

    if (!target || this?.parentElement !== target || !blueprint) return;
    let router = Array.from(target.parentElement?.children ?? []).find(
      (element) =>
        element.tagName === "CLIENT-ROUTER" &&
        element.getAttribute("cache-owner-id") === partialId,
    );
    if (!router) {
      router = template.content.querySelector("client-router") ?? undefined;
      if (!router) return;
      target.insertAdjacentElement("afterend", router);
    }
    console.log("Router element: ", router);

    const routes = router.querySelector<HTMLTemplateElement>("template")
      ?.content;
    console.log("Routes template element content: ", routes);
    if (!routes) return;
    let ownedNodes: Node[] = Array.from(target.childNodes);
    const capture = (records: MutationRecord[]) => {
      const replacement = records.find((record) =>
        record.target === target &&
        Array.from(record.removedNodes).includes(this)
      );
      if (!replacement) {
        ownedNodes = Array.from(target.childNodes);
        return;
      }
      observer.disconnect();
      this.stopCacheObserver = undefined;
      const route = blueprint.cloneNode(true) as Element;
      const insertion = route.querySelector<HTMLTemplateElement>(
        "template[for-partial-id]",
      )!;
      for (const record of records) {
        if (record === replacement) break;
        if (record.target === target) {
          ownedNodes.push(...Array.from(record.addedNodes));
        }
      }
      const removedNodes = records.filter((record) => record.target === target)
        .flatMap((record) => Array.from(record.removedNodes));
      insertion.content.append(
        ...removedNodes.filter((node) => ownedNodes.includes(node)),
      );
      for (const existing of Array.from(routes.children)) {
        if (existing.getAttribute("path") === route.getAttribute("path")) {
          existing.remove();
        }
      }
      routes.append(route);
    };
    const observer = new MutationObserver(capture);

    console.log("Starting cache observer for target: ", target);

    this.abortController?.signal.addEventListener("abort", () => {
      const records = observer.takeRecords();
      observer.disconnect();
      this.stopCacheObserver = undefined;
      capture(records);
    }, { once: true });

    observer.observe(target, { childList: true });
  },
});
