import { runHandlerAttribute } from "./handlerAttribute.v0.1.37.2a9ef56e.js";
customElements.define(
  "lifecycle-element",
  class extends HTMLElement {
    constructor() {
      super();
      console.log(
        `[lifecycle-element] ${this.getAttribute("name")} constructor called`
      );
      const isConnected = this.isConnected;
      console.log("isConnected: ", isConnected);
    }
    connectedCallback() {
      console.log(
        `[lifecycle-element] ${this.getAttribute("name")} connectedCallback called`
      );
      if (this.getAttribute("mounted") === "true") {
        console.log("Element already mounted B, skipping");
      } else {
        console.log("Element mounting");
        this.setAttribute("mounted", "true");
      }
      const mountAttr = this.getAttribute("onMount") ?? this.getAttribute("onmount");
      if (mountAttr) {
        console.log(`[lifecycle-element] Calling mount handler`);
        console.log("this: ", this.firstChild);
        void runHandlerAttribute(this, this, mountAttr);
      }
    }
    disconnectedCallback() {
      const unmountAttr = this.getAttribute("onUnmount") ?? this.getAttribute("onunmount");
      if (unmountAttr) {
        console.log(`[lifecycle-element] Calling unmount handler`);
        void runHandlerAttribute(this, this, unmountAttr);
      }
      this.setAttribute("mounted", "false");
    }
  }
);
