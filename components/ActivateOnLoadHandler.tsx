/**
 * Lifecycle components for @tinytools/hono-tools.
 *
 * Browsers only fire `load` on a handful of elements, so these components
 * emit a tiny trigger (an image or a modulepreload link) whose own `load`
 * event is forwarded to the preceding element. That lets any element bind
 * `onLoad` to run a handler once it is in the document.
 *
 * @module
 */

import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { tiny } from "../mod.ts";
import { Handlers, recordLifecycleTag } from "../clientTools.ts";
import { templateRootTags, transparent } from "../componentScope.ts";
import type { LifecycleElement } from "../lifecycleElement.ts";
import { templateTools } from "../handlers/templateTools.ts";

/** An upgraded custom element: its controller aborts when it disconnects. */
export type PartialAbortableHTMLElement = LifecycleElement;

/** The trigger of `ActivateParsedHandler` and the forwarding of `<upgrade-preceding>`. */
const lifecycleHandlers = new Handlers(import.meta.url, {
  /** Runs the preceding element's `onLoad` handlers; bound to a proxy's `onLoad`. */
  forwardLoad: function (this: HTMLElement): void {
    const target = this.previousElementSibling;
    if (target instanceof HTMLElement) {
      tiny.runHandler(target, new Event("load"));
    }
  },
  /** Runs the preceding element's `onSuspend` handlers; bound to a proxy's `onDisconnect`. */
  forwardSuspend: function (this: HTMLElement): void {
    const target = this.previousElementSibling;
    if (target instanceof HTMLElement) {
      tiny.runHandler(target, new Event("suspend"));
    }
  },
  /**
   * Runs the previous sibling's `onParsed` handlers once, then removes this
   * trigger. `parsed` is not a browser event, so it is dispatched through
   * `runHandler` rather than as a DOM event. A trigger fires `load` once per
   * connection, so one that was moved before it fired may fire again after
   * removing itself; the first firing did the work.
   */
  referParsed: function (this: HTMLElement, _e: Event): void {
    if (!this.isConnected) return;
    const target = this.previousSibling;
    if (target instanceof HTMLElement) {
      tiny.runHandler(target, new Event("parsed"));
    }
    this.remove();
  },
});

/** The lifecycle element rendered after a child that has no custom tag of its own. */
const PROXY_TAG = "upgrade-preceding";

function childList(children: PropsWithChildren["children"]): unknown[] {
  return Array.isArray(children) ? children.flat() : [children];
}

/** A modulepreload link for the bundle holding `handlerName`, used as a load trigger. */
function preloadHref(
  tools: { _handlerFilenames: ReadonlyMap<string, string> },
  handlerName: string,
): string {
  return `/handlers/${tools._handlerFilenames.get(handlerName)}.js`;
}

/**
 * Runs each child's `onParsed` handler exactly once, as soon as the child
 * and its content have been parsed: a trigger link placed right after the
 * child fires when it loads, which is after everything before it exists.
 * The link preloads the bundle holding the trigger's own handler, so it
 * costs no extra request, and as a script preload it is allowed wherever
 * the page's scripts are, unlike an image under a strict `img-src`.
 *
 * `parsed` is distinct from `load`: a lifecycle element's `onLoad` runs again
 * whenever it reconnects, while `onParsed` is for one-time work such as
 * building the element's content from a template.
 */
export async function ActivateParsedHandler(
  { children }: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(lifecycleHandlers);
  return (
    <>
      {childList(children).map((child) => (
        <>
          {child}
          <link
            rel="modulepreload"
            href={preloadHref(lifecycleHandlers, "referParsed")}
            onLoad={fn.referParsed}
          />
        </>
      ))}
    </>
  );
}

/**
 * Clones a `tiny.Templates` entry in place once the children have been
 * parsed, filling the clone's named `<slot>`s from children carrying a
 * matching `slot` attribute and its unnamed `<slot>` from the rest. The
 * children wait inert in a `<template>`, so nothing inside them runs before
 * it sits in the finished clone. `template` is a clone from `tiny.imports`,
 * e.g. `template.card`; the page loads its bundle.
 */
export async function BuildFromTemplate(
  { template, children }: PropsWithChildren<{
    template: { readonly reference: string };
  }>,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(templateTools);
  return (
    <ActivateParsedHandler>
      <template
        onParsed={fn.buildFromTemplate}
        data-template={template.reference}
      >
        {children}
      </template>
    </ActivateParsedHandler>
  );
}

/**
 * The tag of a JSX child when it is a custom element (contains a hyphen).
 * A child is a node with a `tag` under `"jsx": "react-jsx"`, and under
 * `"jsx": "precompile"` the markup of its elements, which counts only when
 * it holds exactly one top-level element.
 */
function customTagName(child: unknown): string | undefined {
  const roots = templateRootTags(child);
  const tag = roots
    ? roots.length === 1 ? roots[0] : undefined
    : typeof child === "object" && child !== null
    ? (child as { tag?: unknown }).tag
    : undefined;
  return typeof tag === "string" && tag.includes("-")
    ? tag.toLowerCase()
    : undefined;
}

/**
 * Upgrades each child to a custom element with lifecycle events: `onLoad`
 * runs whenever the element connects (including after cached restoration),
 * `onDisconnect` when it is removed, and its `abortController` aborts on
 * removal so listeners can clean up.
 *
 * Prefer custom tags (`<note-entry>`): the tag is declared ahead of the
 * markup (a `<meta name="tt-define">` in a full page's head, a `<tt-define>`
 * element in streamed or partial content) and the inline head runtime
 * defines it before the markup is parsed or inserted, so the element
 * upgrades in document order wherever it is placed, moved or cloned, and
 * nothing is rendered beside it. Other tags (an `<input>`, say, which cannot
 * have lifecycle callbacks of its own) get an `<upgrade-preceding>` sibling
 * rendered after them: a lifecycle element that forwards its `load` and
 * `suspend` to the element before it, so it relies on the two staying
 * together.
 */
export async function UpgradeCustomElement(
  props: PropsWithChildren,
): Promise<HtmlEscapedString> {
  // Precompiled markup with async content arrives as a promise of the markup.
  const children = await Promise.all(childList(props.children));
  const tags = children.map(customTagName);
  for (const tag of new Set(tags)) {
    if (tag) recordLifecycleTag(tag);
  }
  if (tags.every(Boolean)) return <>{children}</>;
  recordLifecycleTag(PROXY_TAG);
  const { fn } = await tiny.imports(lifecycleHandlers);
  return (
    <>
      {children.map((child, index) => (
        tags[index] ? child : (
          <>
            {child}
            <upgrade-preceding
              onLoad={fn.forwardLoad}
              onDisconnect={fn.forwardSuspend}
            >
            </upgrade-preceding>
          </>
        )
      ))}
    </>
  );
}

// Framework wrappers render into the caller's component scope.
transparent(ActivateParsedHandler);
transparent(BuildFromTemplate);
transparent(UpgradeCustomElement);
