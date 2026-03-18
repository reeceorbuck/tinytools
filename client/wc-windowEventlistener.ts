/**
 * Window Event Listener Web Component for @tinytools/hono-tools
 *
 * A web component that attaches event listeners to window/document/navigation objects.
 */

/// <reference lib="dom" />

import type { HandlerProxy } from "./eventHandlers.ts";

/**
 * Window event attribute mappings (all lowercase keys).
 * Maps HTML attribute names (e.g., "onload") to the actual window event names (e.g., "load").
 */
const windowEventMap: Record<
  string,
  { target: EventTarget; eventName: string }
> = {
  onload: { target: globalThis, eventName: "load" },
  onresize: { target: globalThis, eventName: "resize" },
  onscroll: { target: globalThis, eventName: "scroll" },
  onhashchange: { target: globalThis, eventName: "hashchange" },
  onpopstate: { target: globalThis, eventName: "popstate" },
  ononline: { target: globalThis, eventName: "online" },
  onoffline: { target: globalThis, eventName: "offline" },
  onmessage: { target: globalThis, eventName: "message" },
  onstorage: { target: globalThis, eventName: "storage" },
  onbeforeunload: { target: globalThis, eventName: "beforeunload" },
  onunload: { target: globalThis, eventName: "unload" },
  onvisibilitychange: {
    target: globalThis.document,
    eventName: "visibilitychange",
  },
  onfocus: { target: globalThis, eventName: "focus" },
  onblur: { target: globalThis, eventName: "blur" },
  onerror: { target: globalThis, eventName: "error" },
  // Navigation API events
  onnavigate: { target: globalThis.navigation, eventName: "navigate" },
  onnavigatesuccess: {
    target: globalThis.navigation,
    eventName: "navigatesuccess",
  },
  onnavigateerror: {
    target: globalThis.navigation,
    eventName: "navigateerror",
  },
  oncurrententrychange: {
    target: globalThis.navigation,
    eventName: "currententrychange",
  },
};

/**
 * A web component that attaches event listeners to window/document/navigation objects.
 *
 * @example
 * ```html
 * <window-event-listener
 *   onResize={fn.handleResize}
 *   onVisibilityChange={fn.handleVisibility}
 * />
 * ```
 */
customElements.define(
  "window-event-listener",
  class extends HTMLElement {
    private abortController: AbortController | null = null;
    private targetElements: Element[] = [];
    private replacedSelf = false;

    connectedCallback() {
      // Capture all direct element children as targets for handlers
      this.targetElements = Array.from(this.children);

      this.setupEventListeners();

      // Copy event handler attributes to children for DOM inspection
      this.copyHandlerAttributesToChildren();

      // Replace this element with its children in the DOM
      // The event listeners remain active since they're on window/document/navigation
      this.replacedSelf = true;
      this.replaceWithChildren();
    }

    disconnectedCallback() {
      // Don't abort if we intentionally replaced ourselves
      if (this.replacedSelf) return;

      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    }

    private replaceWithChildren() {
      const parent = this.parentNode;
      if (!parent) return;

      // Move all children before this element, then remove this element
      if (this.children.length === 0) {
        console.warn(
          "window-event-listener has no children to replace itself with",
        );
        return;
      }
      while (this.firstChild) {
        parent.insertBefore(this.firstChild, this);
      }
      parent.removeChild(this);
    }

    private copyHandlerAttributesToChildren() {
      for (const attr of Array.from(this.attributes)) {
        const attrNameLower = attr.name.toLowerCase();
        if (!attrNameLower.startsWith("on")) continue;
        if (!windowEventMap[attrNameLower]) continue;

        // Copy the attribute to each direct child element
        for (const child of this.targetElements) {
          child.setAttribute(attr.name, attr.value);
        }
      }
    }

    private setupEventListeners() {
      if (this.abortController) {
        this.abortController.abort();
      }
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      for (const attr of Array.from(this.attributes)) {
        const attrNameLower = attr.name.toLowerCase();

        if (!attrNameLower.startsWith("on")) continue;

        const eventConfig = windowEventMap[attrNameLower];
        if (!eventConfig) continue;

        const handlerName = attr.value.match(/^handlers\.(\w+)/)?.[1];
        if (!handlerName) continue;

        this.addWindowEventListener(eventConfig, handlerName, signal);
      }
    }

    private addWindowEventListener(
      eventConfig: { target: EventTarget; eventName: string },
      handlerName: string,
      signal: AbortSignal,
    ) {
      const { target, eventName } = eventConfig;
      const targetElements = this.targetElements;

      target.addEventListener(
        eventName,
        (event: Event) => {
          // Call handler for each captured child element
          for (const element of targetElements) {
            (globalThis.handlers as HandlerProxy)[handlerName].call(
              element,
              event,
            );
          }
        },
        { signal },
      );

      console.log(
        `[window-event-listener] Added ${eventName} listener for handler "${handlerName}" (${targetElements.length} target elements)`,
      );
    }
  },
);
