/**
 * The browser runtime behind `UpgradeCustomElement`.
 *
 * It ships inline in every page's head script (see `honoFactory.tsx`), so
 * `tiny.defineLifecycleElement` exists before any body content is parsed.
 * Tags are declared by `AssetTags`: in a full page's head as
 * `<meta name="tt-define" content="note-entry">`, which the head script
 * defines as it runs, and elsewhere (streamed content, partial updates) as
 * `<tt-define tag="note-entry">`, a custom element that defines its tag the
 * moment it connects. Either way the tag is defined before the markup that
 * follows it is parsed or inserted, so lifecycle elements upgrade in document
 * order and never after a later trigger has already fired.
 *
 * @module
 */

/** The `tiny` global every page defines in its head. */
declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };

/** The name of the `<meta>` and the tag of the element that declare a lifecycle tag. */
export const LIFECYCLE_TAG_DECLARATION = "tt-define";

/** An upgraded custom element: its controller aborts when it disconnects. */
export interface LifecycleElement extends HTMLElement {
  abortController: AbortController;
}

/**
 * Defines `tagName` as a lifecycle element: connecting fires `load` (so an
 * `onLoad` handler runs) and then `connect`, and disconnecting fires
 * `disconnect` and aborts the element's `abortController`, so listeners
 * registered with its signal clean themselves up. A tag already defined is
 * left alone, so a tag may be declared any number of times.
 */
export function defineLifecycleElement(tagName: string): void {
  if (customElements.get(tagName)) return;
  customElements.define(
    tagName,
    class extends HTMLElement implements LifecycleElement {
      abortController = new AbortController();

      connectedCallback(): void {
        this.abortController = new AbortController();
        this.dispatchEvent(new Event("load"));
        tiny.runHandler(this, new Event("connect"));
      }

      disconnectedCallback(): void {
        tiny.runHandler(this, new Event("disconnect"));
        this.abortController.abort();
      }
    },
  );
}

/**
 * Installs the tag declarations: defines `<tt-define tag="...">`, whose
 * connection defines its tag, and defines the tags of the
 * `<meta name="tt-define">` elements already in the head. Runs once, from
 * the inline head script, before the body is parsed.
 */
export function defineLifecycleTags(): void {
  // The head script may be evaluated outside a browser (tests do).
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
