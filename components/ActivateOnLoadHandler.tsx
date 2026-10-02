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
import { Handlers } from "../clientTools.ts";
import { transparent } from "../componentScope.ts";

/** An upgraded custom element: its controller aborts when it disconnects. */
export interface PartialAbortableHTMLElement extends HTMLElement {
  abortController: AbortController;
}

/** A 1x1 transparent GIF whose `load` event triggers the preceding element's handler. */
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

/** Forwards lifecycle events to neighbouring elements. */
const lifecycleHandlers = new Handlers(import.meta.url, {
  /** Fires `load` on the previous sibling once, then removes this trigger. */
  referOnLoadOnce: function (this: HTMLElement, _e: Event): void {
    const target = this.previousSibling;
    if (target instanceof Element) target.dispatchEvent(new Event("load"));
    this.remove();
  },
  /** Fires `load` on the first child of the previous sibling. */
  referOnLoad: function (this: HTMLElement, _e: Event): void {
    const target = this.previousSibling?.firstChild;
    if (target instanceof Element) target.dispatchEvent(new Event("load"));
  },
  /** Fires `suspend` on this element's first child. */
  referOnSuspend: function (this: HTMLElement, _e: Event): void {
    const target = this.firstChild;
    if (target instanceof Element) target.dispatchEvent(new Event("suspend"));
  },
  /** Fires `load` on this element's first element child. */
  referOnConnect: function (this: HTMLElement): void {
    this.firstElementChild?.dispatchEvent(new Event("load"));
  },
});

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
 * Runs each child's `onLoad` handler once it is in the document, for
 * elements that do not fire `load` natively.
 */
export async function ActivateOnLoadHandler(
  { children }: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(lifecycleHandlers);
  return (
    <>
      {childList(children).map((child) => (
        <>
          {child}
          <img hidden src={TRANSPARENT_PIXEL} onLoad={fn.referOnLoadOnce} />
        </>
      ))}
    </>
  );
}

/**
 * Wraps each child in an `<abortable-lifecycle-element>` that forwards
 * `load` on connection and `suspend` on removal to the child.
 */
export async function ActivateLifecycleHandlers(
  { children }: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(lifecycleHandlers);
  return (
    <>
      {childList(children).map((child) => (
        <>
          <abortable-lifecycle-element
            onLoad={fn.referOnConnect}
            onSuspend={fn.referOnSuspend}
          >
            {child}
          </abortable-lifecycle-element>
          <link
            rel="modulepreload"
            href={preloadHref(lifecycleHandlers, "referOnLoad")}
            onLoad={fn.referOnLoad}
          />
        </>
      ))}
    </>
  );
}

/** Builds a `<template id="...">` into the element, filling its named slots. */
export const buildTemplateHandlers = new Handlers(import.meta.url, {
  buildTemplate: function (this: HTMLElement, _e: Event): void {
    const templateId = this.dataset.template;
    const template = templateId ? document.getElementById(templateId) : null;
    if (!(template instanceof HTMLTemplateElement)) {
      console.error(`buildTemplate: template "${templateId}" not found.`);
      return;
    }

    const built = template.content.cloneNode(true) as DocumentFragment;
    const childTemplate = this.querySelector("template");
    const insertContent = childTemplate?.content.cloneNode(true) as
      | DocumentFragment
      | undefined;

    for (const slotChild of Array.from(insertContent?.children ?? [])) {
      const slotName = slotChild.getAttribute("slot");
      if (!slotName) continue;
      const slotElement = built.querySelector(`slot[name="${slotName}"]`);
      if (!slotElement) {
        console.error(`buildTemplate: no slot named "${slotName}".`);
        continue;
      }
      const inputClone = slotChild.cloneNode(true) as HTMLElement;
      inputClone.removeAttribute("slot");
      slotElement.insertAdjacentElement("beforebegin", inputClone);
    }
    this.appendChild(built);
    childTemplate?.remove();
  },
  /** Replaces the parent element with a textarea carrying its attributes and decoded text. */
  loadTextArea: function (this: HTMLElement, _e: Event): void {
    const replaceElement = this.parentElement;
    if (!replaceElement) {
      console.error("loadTextArea: no parent element found.");
      return;
    }
    const textarea = document.createElement("textarea");
    for (const attribute of Array.from(replaceElement.attributes)) {
      textarea.setAttribute(attribute.name, attribute.value);
    }
    textarea.value = new DOMParser().parseFromString(
      replaceElement.textContent,
      "text/html",
    ).body.textContent;
    replaceElement.setAttribute("replaced", "true");
    replaceElement.replaceWith(textarea);
  },
});

/**
 * Renders the child element and builds the `<template id={templateId}>`
 * into it on load, filling the template's named slots from the children.
 */
export async function BuildFromTemplateElement(
  { children, templateId }: PropsWithChildren<{ templateId: string }>,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(buildTemplateHandlers);
  return (
    <ActivateOnLoadHandler>
      <temp-element onLoad={fn.buildTemplate} data-template={templateId}>
        <template>{children}</template>
      </temp-element>
    </ActivateOnLoadHandler>
  );
}

const upgradePrecedingTools = new Handlers(import.meta.url, {
  /**
   * Defines the preceding element's tag as a custom element whose
   * `connectedCallback` fires `load` and whose `disconnectedCallback`
   * aborts `abortController`. Elements without a custom tag get a proxy
   * `<upgrade-preceding>` sibling that forwards those events to them.
   */
  upgradePrecedingCustomElement: function (this: HTMLElement): void {
    const precedingElement = this.previousElementSibling as
      | HTMLElement
      | null;
    if (!precedingElement) {
      console.error("upgradePrecedingCustomElement: no preceding element.");
      return;
    }

    let upgradeTagName = precedingElement.tagName.toLowerCase();
    if (!upgradeTagName.includes("-")) {
      upgradeTagName = "upgrade-preceding";
      const proxyElement = document.createElement(
        upgradeTagName,
      ) as PartialAbortableHTMLElement;
      proxyElement.addEventListener("load", function () {
        tiny.runHandler(precedingElement, new Event("load"));
        // Remove the proxy if the element it stands for is removed.
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (Array.from(mutation.removedNodes).includes(precedingElement)) {
              proxyElement.remove();
            }
          }
        });
        observer.observe(precedingElement.parentElement!, { childList: true });
        proxyElement.addEventListener("load", () => {
          tiny.runHandler(precedingElement, new Event("load"));
          observer.observe(precedingElement.parentElement!, {
            childList: true,
          });
        }, { signal: proxyElement.abortController.signal });
        proxyElement.addEventListener("suspend", () => {
          tiny.runHandler(precedingElement, new Event("suspend"));
          observer.disconnect();
        }, { signal: proxyElement.abortController.signal });
      }, { once: true });
      precedingElement.insertAdjacentElement("afterend", proxyElement);
    }

    if (!customElements.get(upgradeTagName)) {
      customElements.define(
        upgradeTagName,
        class extends HTMLElement {
          abortController = new AbortController();

          connectedCallback() {
            this.abortController = new AbortController();
            this.dispatchEvent(new Event("load"));
            tiny.runHandler(this, new Event("connect"));
          }

          disconnectedCallback() {
            tiny.runHandler(this, new Event("disconnect"));
            this.abortController.abort();
          }
        },
      );
    }
    this.remove();
  },
});

/**
 * Upgrades each child to a custom element with lifecycle events: `onLoad`
 * runs whenever the element connects (including after cached restoration),
 * `onDisconnect` when it is removed, and its `abortController` aborts on
 * removal so listeners can clean up.
 */
export async function UpgradeCustomElement(
  props: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(upgradePrecedingTools);
  return (
    <>
      {childList(props.children).map((child) => (
        <>
          {child}
          <link
            rel="modulepreload"
            href={preloadHref(
              upgradePrecedingTools,
              "upgradePrecedingCustomElement",
            )}
            onLoad={fn.upgradePrecedingCustomElement}
          />
        </>
      ))}
    </>
  );
}

// Framework wrappers render into the caller's component scope.
transparent(ActivateOnLoadHandler);
transparent(ActivateLifecycleHandlers);
transparent(BuildFromTemplateElement);
transparent(UpgradeCustomElement);
