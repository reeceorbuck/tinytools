import { runHandlerAttribute } from "./handlerAttribute.v0.1.37.2a9ef56e.js";
import {
  getPartialContentContext
} from "./partialContentContext.v0.1.37.cd97d5bb.js";
class PartialContentElement extends HTMLElement {
  get partialContext() {
    return getPartialContentContext(this);
  }
  connectedCallback() {
    if (this.getAttribute("mounted") === "true") return;
    this.setAttribute("mounted", "true");
    const mountAttribute = this.getAttribute("onMount") ?? this.getAttribute("onmount");
    if (!mountAttribute) {
      console.error(`Partial content "${this.id}" is missing onMount.`);
      return;
    }
    Promise.resolve(
      runHandlerAttribute(this, this, mountAttribute)
    ).catch((error) => {
      console.error(`Partial mount handler failed:`, error);
    });
  }
}
if (!customElements.get("partial-content")) {
  customElements.define("partial-content", PartialContentElement);
}
export {
  PartialContentElement
};
