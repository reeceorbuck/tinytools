function extractHandlerName(attrValue) {
  const match = attrValue.match(/^handlers\.(\w+)/);
  if (match) {
    return match[1];
  }
  return attrValue;
}
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
        const mountHandler = extractHandlerName(mountAttr);
        console.log(
          `[lifecycle-element] Calling mount handler "${mountHandler}"`
        );
        console.log("this: ", this.firstChild);
        globalThis.handlers[mountHandler].call(this, this);
      }
    }
    disconnectedCallback() {
      const unmountAttr = this.getAttribute("onUnmount") ?? this.getAttribute("onunmount");
      if (unmountAttr) {
        const unmountHandler = extractHandlerName(unmountAttr);
        console.log(
          `[lifecycle-element] Calling unmount handler "${unmountHandler}"`
        );
        globalThis.handlers[unmountHandler].call(this, this);
      }
      this.setAttribute("mounted", "false");
    }
  }
);
