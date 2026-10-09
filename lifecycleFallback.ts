/**
 * The lifecycle fallback for browsers without customized built-in elements
 * (Safari). Only those browsers load it: the lifecycle runtime imports it
 * the first time it is asked to define an `is` name it cannot register (see
 * `lifecycleElement.ts`), so the inline runtime stays small everywhere else.
 *
 * Served as an ES module by `tiny.middleware.core()`; the function below is
 * inlined by `toString()` beside the state it declares, so it may only use
 * that state, its arguments and the DOM.
 *
 * @module
 */

/** @internal The module state declared beside the function. */
declare const fallbackState: {
  /** The `is` names whose elements get lifecycle events. */
  names: Set<string>;
  observer?: MutationObserver;
};

/**
 * Records that elements with `is="tagName"` get lifecycle events, and starts
 * (once) the observer that connects and disconnects every element carrying
 * a recorded `is` as it enters or leaves the document. Elements already
 * present are connected at once.
 */
export function observeBuiltinFallback(
  tagName: string,
  connect: (element: HTMLElement) => void,
  disconnect: (element: HTMLElement) => void,
): void {
  const { names } = fallbackState;
  if (names.has(tagName)) return;
  names.add(tagName);
  const recorded = (node: Node): HTMLElement[] => {
    if (!(node instanceof HTMLElement)) return [];
    const found = Array.from(node.querySelectorAll<HTMLElement>("[is]"));
    if (node.hasAttribute("is")) found.unshift(node);
    return found.filter((element) => names.has(element.getAttribute("is")!));
  };
  if (!fallbackState.observer) {
    fallbackState.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          for (const element of recorded(node)) disconnect(element);
        }
        for (const node of record.addedNodes) {
          for (const element of recorded(node)) connect(element);
        }
      }
    });
    fallbackState.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  for (
    const element of document.querySelectorAll<HTMLElement>(
      `[is="${tagName}"]`,
    )
  ) {
    connect(element);
  }
}
