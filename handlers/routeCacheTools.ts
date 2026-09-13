import { Handlers } from "../clientTools.ts";

type CacheObserverElement = HTMLTemplateElement & {
  stopCacheObserver?: () => void;
};

export const routeCacheTools = new Handlers(import.meta.url, {
  observeRouteCache: function (this: CacheObserverElement) {
    if (this.stopCacheObserver || !this.isConnected) return;
    const partialId = this.getAttribute("cache-partial-id");
    const target = partialId ? document.getElementById(partialId) : null;
    const lifecycle = this.parentElement;
    const blueprint = this.content.querySelector("client-route");
    if (!target || lifecycle?.parentElement !== target || !blueprint) return;
    let router = Array.from(target.parentElement?.children ?? []).find(
      (element) =>
        element.tagName === "CLIENT-ROUTER" &&
        element.getAttribute("for-partial-id") === partialId,
    );
    if (!router) {
      router = this.content.querySelector("client-router") ?? undefined;
      if (!router) return;
      target.insertAdjacentElement("afterend", router);
    }
    const routes = router.querySelector<HTMLTemplateElement>(
      "abortable-lifecycle-element > template",
    );
    if (!routes) return;
    let ownedNodes: Node[] = Array.from(target.childNodes);
    const capture = (records: MutationRecord[]) => {
      const replacement = records.find((record) =>
        record.target === target &&
        Array.from(record.removedNodes).includes(lifecycle)
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
      for (const existing of Array.from(routes.content.children)) {
        if (existing.getAttribute("path") === route.getAttribute("path")) {
          existing.remove();
        }
      }
      routes.content.append(route);
    };
    const observer = new MutationObserver(capture);
    this.stopCacheObserver = () => {
      const records = observer.takeRecords();
      observer.disconnect();
      this.stopCacheObserver = undefined;
      capture(records);
    };
    observer.observe(target, { childList: true });
  },
  suspendRouteCache: function (this: CacheObserverElement) {
    this.stopCacheObserver?.();
  },
});
