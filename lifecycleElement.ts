/**
 * The browser runtime behind lifecycle elements.
 *
 * It is not part of the core head script: a page only gets it once it uses a
 * lifecycle tag. A full page that declares tags in its head runs it inline
 * right after the core script, so `tiny.defineLifecycleElement` exists
 * before any body content is parsed. Content that arrives later (streamed
 * Suspense chunks, partial updates, pushed updates) carries it inline ahead
 * of its `<tt-define>` declarations, and template bundles import it as a
 * module; every copy after the first does nothing.
 *
 * Tags are declared by `AssetTags`: in a full page's head as
 * `<meta name="tt-define" content="note-entry">`, which the runtime defines
 * as it runs, and elsewhere as `<tt-define tag="note-entry">`, a custom
 * element that defines its tag the moment it connects. Either way the tag is
 * defined before the markup that follows it is parsed or inserted, so
 * lifecycle elements upgrade in document order and never after a later
 * trigger has already fired.
 *
 * A declaration is a custom tag (`note-entry`) or, for a customized built-in
 * element written `<button is="custom-button">`, the `is` name and the tag it
 * extends joined by a colon (`custom-button:button`). A browser without
 * customized built-ins (Safari) imports `lifecycleFallback.ts` instead, a
 * document-wide MutationObserver that fires the same events on elements
 * carrying a declared `is` as they enter and leave the document.
 *
 * Every runtime function here is inlined by `toString()`, so each may only
 * use the others, the DOM, `tiny` and the `lifecycleState` the runtime
 * declares.
 *
 * @module
 */

import { observeBuiltinFallback } from "./lifecycleFallback.ts";

/** The `tiny` global every page defines in its head. */
declare const tiny: {
  runHandler(target: HTMLElement, event: Event): unknown;
  defineLifecycleElement?: (declaration: string) => void;
};

/** @internal The runtime state the lifecycle runtime declares beside these functions. */
declare const lifecycleState: {
  /** Whether customized built-in elements work here; probed on first use. */
  builtins?: boolean;
  /** The URL of the fallback module for browsers without them. */
  fallback: string;
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
 * Defines the declared tag as a lifecycle element: connecting runs its
 * `onConnect` handlers, and disconnecting runs its `onDisconnect` handlers
 * and aborts the element's `abortController`, so listeners registered with
 * its signal clean themselves up. A customized built-in
 * (`custom-button:button`) extends the class of the tag it customizes, or
 * where the browser has no such elements, hands the name to the observer
 * fallback, imported on first use. A tag
 * already defined is left alone, so a tag may be declared any number of
 * times.
 */
export function defineLifecycleElement(declaration: string): void {
  const colon = declaration.indexOf(":");
  const tagName = colon < 0 ? declaration : declaration.slice(0, colon);
  const extendsTag = colon < 0 ? "" : declaration.slice(colon + 1);
  if (customElements.get(tagName)) return;
  if (extendsTag && !supportsCustomizedBuiltins()) {
    import(lifecycleState.fallback).then((fallback) =>
      fallback.observeBuiltinFallback(
        tagName,
        connectLifecycle,
        disconnectLifecycle,
      )
    );
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
 * `<meta name="tt-define">` elements already in the document. Runs once,
 * when the runtime first loads.
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

/**
 * Strips comment lines and indentation from a function's source for
 * inlining. Line-based, so inlined functions must not hold multi-line
 * strings or template literals.
 */
export function compactSource(source: string): string {
  return source.split("\n").map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//")).join("\n");
}

/** Short FNV-1a hash of `source`, for the runtime's immutable file names. */
function sourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const fallbackSource = [
  "const fallbackState = {names: new Set()};",
  "export " + compactSource(observeBuiltinFallback.toString()),
].join("\n");

/** The path the observer fallback module is served at. */
export const lifecycleFallbackPath = `/tt-lifecycle-fallback_${
  sourceHash(fallbackSource)
}.js`;

/**
 * The lifecycle runtime: defines `tiny.defineLifecycleElement` and
 * `<tt-define>`, and the tags of the head's `<meta name="tt-define">`
 * elements. Runs as an inline classic script or as a module; once
 * `tiny.defineLifecycleElement` exists it does nothing, so a page may
 * receive it any number of times.
 */
export const lifecycleRuntimeScript = [
  "tiny.defineLifecycleElement || (() => {",
  `const lifecycleState = {fallback: ${
    JSON.stringify(lifecycleFallbackPath)
  }};`,
  ...[
    supportsCustomizedBuiltins,
    connectLifecycle,
    disconnectLifecycle,
    defineLifecycleElement,
    defineLifecycleTags,
  ].map((runtimeFunction) => compactSource(runtimeFunction.toString())),
  "tiny.defineLifecycleElement = defineLifecycleElement;",
  "defineLifecycleTags();",
  "})();",
].join("\n");

/** The path the lifecycle runtime is served at as a module, for template bundles. */
export const lifecycleRuntimePath = `/tt-lifecycle_${
  sourceHash(lifecycleRuntimeScript)
}.js`;

/** The lifecycle runtime's module files, by path, served by `tiny.middleware.core()`. */
export const lifecycleRuntimeFiles: ReadonlyMap<string, string> = new Map([
  [lifecycleRuntimePath, lifecycleRuntimeScript],
  [lifecycleFallbackPath, fallbackSource],
]);
