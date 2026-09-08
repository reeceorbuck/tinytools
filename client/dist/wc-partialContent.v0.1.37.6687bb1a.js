import { runHandlerAttribute } from "./handlerAttribute.v0.1.37.6f52ccea.js";
class PartialContentElement extends HTMLElement {
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
