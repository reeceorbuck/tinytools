/**
 * Lifecycle Element Web Component for @tiny-tools/hono
 *
 * A web component that calls client functions when mounted or unmounted from the DOM.
 */

/// <reference lib="dom" />

import type { HandlerProxy } from "./eventHandlers.ts";

/**
 * Extracts the handler name from an attribute value.
 * Handles both plain names and full expressions like "handlers.handleMount_6fec3866(this, event)"
 */
function extractHandlerName(attrValue: string): string {
  const match = attrValue.match(/^handlers\.([^(]+)\(/);
  if (match) {
    return match[1];
  }
  return attrValue;
}

/**
 * A web component that calls client functions when mounted or unmounted from the DOM.
 *
 * @example
 * ```html
 * <lifecycle-element onMount="myMountHandler" onUnmount="myUnmountHandler"></lifecycle-element>
 * ```
 *
 * Attributes:
 * - onMount/onmount: The name of the handler function to call when the element is added to the DOM
 * - onUnmount/onunmount: The name of the handler function to call when the element is removed from the DOM
 */
customElements.define(
  "lifecycle-element",
  class extends HTMLElement {
    constructor() {
      super();
      console.log(
        `[lifecycle-element] ${this.getAttribute("name")} constructor called`,
      );
      const isConnected = this.isConnected;
      console.log("isConnected: ", isConnected);
    }

    connectedCallback() {
      console.log(
        `[lifecycle-element] ${
          this.getAttribute("name")
        } connectedCallback called`,
      );
      if (this.getAttribute("mounted") === "true") {
        console.log("Element already mounted B, skipping");
        //return;
      } else {
        console.log("Element mounting");
        this.setAttribute("mounted", "true");
      }
      const mountAttr = this.getAttribute("onMount") ??
        this.getAttribute("onmount");
      if (mountAttr) {
        const mountHandler = extractHandlerName(mountAttr);
        console.log(
          `[lifecycle-element] Calling mount handler "${mountHandler}"`,
        );
        console.log("this: ", this.firstChild);
        (globalThis.handlers as HandlerProxy)[mountHandler](this);
      }
    }

    disconnectedCallback() {
      const unmountAttr = this.getAttribute("onUnmount") ??
        this.getAttribute("onunmount");
      if (unmountAttr) {
        const unmountHandler = extractHandlerName(unmountAttr);
        console.log(
          `[lifecycle-element] Calling unmount handler "${unmountHandler}"`,
        );
        (globalThis.handlers as HandlerProxy)[unmountHandler](this);
      }
      this.setAttribute("mounted", "false");
    }
  },
);
