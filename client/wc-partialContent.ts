/// <reference lib="dom" />

import { runHandlerAttribute } from "./handlerAttribute.ts";
import {
  getPartialContentContext,
  type PartialContentContext,
} from "./partialContentContext.ts";
export type {
  PartialContentContext,
  PartialContentProcessingOptions,
} from "./partialContentContext.ts";

export class PartialContentElement extends HTMLElement {
  get partialContext(): PartialContentContext | undefined {
    return getPartialContentContext(this);
  }

  connectedCallback() {
    if (this.getAttribute("mounted") === "true") return;
    this.setAttribute("mounted", "true");

    const mountAttribute = this.getAttribute("onMount") ??
      this.getAttribute("onmount");
    if (!mountAttribute) {
      console.error(`Partial content "${this.id}" is missing onMount.`);
      return;
    }

    Promise.resolve(
      runHandlerAttribute(this, this, mountAttribute),
    ).catch((error) => {
      console.error(`Partial mount handler failed:`, error);
    });
  }
}

if (!customElements.get("partial-content")) {
  customElements.define("partial-content", PartialContentElement);
}
