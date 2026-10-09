/**
 * The browser runtime behind lifecycle elements.
 *
 * It is the runtime script every page loads at the end of its head (see
 * `honoFactory.tsx`), so `tiny.defineLifecycleElement` exists before any body
 * content is parsed. Tags are declared by `AssetTags`: in a full page's head as
 * `<meta name="tt-define" content="note-entry">`, which the head script
 * defines as it runs, and elsewhere (streamed content, partial updates) as
 * `<tt-define tag="note-entry">`, a custom element that defines its tag the
 * moment it connects. Either way the tag is defined before the markup that
 * follows it is parsed or inserted, so lifecycle elements upgrade in document
 * order and never after a later trigger has already fired.
 *
 * A declaration is a custom tag (`note-entry`) or, for a customized built-in
 * element written `<button is="custom-button">`, the `is` name and the tag it
 * extends joined by a colon (`custom-button:button`). A browser without
 * customized built-ins (Safari) gets a document-wide MutationObserver
 * instead, started by the first such declaration, that fires the same
 * events on elements carrying a declared `is` as they enter and leave the
 * document.
 *
 * Every function here is inlined by `toString()`, so each may only use the
 * others, the DOM, and the two globals the head script declares.
 *
 * @module
 */

/** The `tiny` global every page defines in its head. */
declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };

/** @internal The runtime state the runtime script declares beside these functions. */
declare const lifecycleState: {
  /** Whether customized built-in elements work here; probed on first use. */
  builtins?: boolean;
  /** The `is` names the observer fallback handles, with the tag each extends. */
  fallbacks: Map<string, string>;
  observer?: MutationObserver;
};

/** The name of the `<meta>` and the tag of the element that declare a lifecycle tag. */
export const LIFECYCLE_TAG_DECLARATION = "tt-define";

/** An upgraded custom element: its controller aborts when it disconnects. */
export interface LifecycleElement extends HTMLElement {
  abortController: AbortController;
}

/**
 * The declaration of a lifecycle tag: the custom tag itself, or for a
 * customized built-in the `is` name and the tag it extends joined by a colon.
 */
export function lifecycleTagDeclaration(
  tagName: string,
  extendsTag?: string,
): string {
  return extendsTag ? `${tagName}:${extendsTag}` : tagName;
}

/** Whether `customElements.define` with `extends` produces working elements here. */
export function supportsCustomizedBuiltins(): boolean {
  if (!("builtins" in lifecycleState)) {
    const probe = "tt-builtin-probe";
    try {
      class Probe extends HTMLParagraphElement {}
      customElements.define(probe, Probe, { extends: "p" });
      lifecycleState.builtins =
        document.createElement("p", { is: probe }) instanceof Probe;
    } catch {
      lifecycleState.builtins = false;
    }
  }
  return lifecycleState.builtins === true;
}

/** Gives `element` a fresh controller and runs its `onConnect` handlers. */
export function connectLifecycle(element: HTMLElement): void {
  (element as LifecycleElement).abortController = new AbortController();
  tiny.runHandler(element, new Event("connect"));
}

/** Fires `disconnect` on `element` and aborts its controller, so its listeners clean up. */
export function disconnectLifecycle(element: HTMLElement): void {
  tiny.runHandler(element, new Event("disconnect"));
  (element as Partial<LifecycleElement>).abortController?.abort();
}

/**
 * The fallback for browsers without customized built-ins: records that
 * elements with `is="tagName"` get lifecycle events, and starts (once) the
 * observer that connects and disconnects every element carrying a recorded
 * `is` as it enters or leaves the document. Elements already present are
 * connected at once.
 */
export function observeBuiltinFallback(
  tagName: string,
  extendsTag: string,
): void {
  const { fallbacks } = lifecycleState;
  if (fallbacks.has(tagName)) return;
  fallbacks.set(tagName, extendsTag);
  const recorded = (node: Node): HTMLElement[] => {
    if (!(node instanceof HTMLElement)) return [];
    const found = Array.from(node.querySelectorAll<HTMLElement>("[is]"));
    if (node.hasAttribute("is")) found.unshift(node);
    return found.filter((element) =>
      fallbacks.has(element.getAttribute("is") ?? "")
    );
  };
  if (!lifecycleState.observer) {
    lifecycleState.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          for (const element of recorded(node)) disconnectLifecycle(element);
        }
        for (const node of record.addedNodes) {
          for (const element of recorded(node)) connectLifecycle(element);
        }
      }
    });
    lifecycleState.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  for (
    const element of document.querySelectorAll<HTMLElement>(
      `[is="${tagName}"]`,
    )
  ) {
    connectLifecycle(element);
  }
}

/**
 * Defines the declared tag as a lifecycle element: connecting runs its
 * `onConnect` handlers, and disconnecting runs its `onDisconnect` handlers
 * and aborts the element's `abortController`, so listeners registered with
 * its signal clean themselves up. A customized built-in
 * (`custom-button:button`) extends the class of the tag it customizes, or
 * falls back to the observer where the browser has no such elements. A tag
 * already defined is left alone, so a tag may be declared any number of
 * times.
 */
export function defineLifecycleElement(declaration: string): void {
  const colon = declaration.indexOf(":");
  const tagName = colon < 0 ? declaration : declaration.slice(0, colon);
  const extendsTag = colon < 0 ? "" : declaration.slice(colon + 1);
  if (customElements.get(tagName)) return;
  if (extendsTag && !supportsCustomizedBuiltins()) {
    observeBuiltinFallback(tagName, extendsTag);
    return;
  }
  const Base = extendsTag
    ? document.createElement(extendsTag).constructor as typeof HTMLElement
    : HTMLElement;
  customElements.define(
    tagName,
    class extends Base implements LifecycleElement {
      abortController = new AbortController();

      connectedCallback(): void {
        connectLifecycle(this);
      }

      disconnectedCallback(): void {
        disconnectLifecycle(this);
      }
    },
    extendsTag ? { extends: extendsTag } : {},
  );
}

/**
 * Installs the tag declarations: defines `<tt-define tag="...">`, whose
 * connection defines its tag, and defines the tags of the
 * `<meta name="tt-define">` elements already in the head. Runs once, from
 * the runtime script, before the body is parsed.
 */
export function defineLifecycleTags(): void {
  // The runtime script may be evaluated outside a browser (tests do).
  if (!globalThis.customElements) return;
  customElements.define(
    "tt-define",
    class extends HTMLElement {
      connectedCallback(): void {
        const tagName = this.getAttribute("tag");
        if (tagName) defineLifecycleElement(tagName);
        // Its work is done the moment it connects; leave no trace behind.
        this.remove();
      }
    },
  );
  for (
    const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="tt-define"]',
    )
  ) {
    defineLifecycleElement(meta.content);
  }
}
