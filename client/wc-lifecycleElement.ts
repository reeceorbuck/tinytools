/**
 * Lifecycle Element Web Component for @tinytools/hono-tools
 *
 * A web component that calls client functions when mounted or unmounted from the DOM.
 */

/// <reference lib="dom" />

import { runHandlerAttribute } from "./handlerAttribute.ts";

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
        console.log(`[lifecycle-element] Calling mount handler`);
        console.log("this: ", this.firstChild);
        void runHandlerAttribute(this, this, mountAttr);
      }
    }

    disconnectedCallback() {
      const unmountAttr = this.getAttribute("onUnmount") ??
        this.getAttribute("onunmount");
      if (unmountAttr) {
        console.log(`[lifecycle-element] Calling unmount handler`);
        void runHandlerAttribute(this, this, unmountAttr);
      }
      this.setAttribute("mounted", "false");
    }
  },
);
