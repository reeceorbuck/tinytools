class AbortablePartialContent extends HTMLElement {
  abortController;
  constructor() {
    super();
    console.log("New AbortablePartialContent constructed");
  }
  connectedCallback() {
    this.dispatchEvent(new Event("load"));
  }
  disconnectedCallback() {
    this.dispatchEvent(new Event("suspend"));
  }
}
customElements.define("abortable-lifecycle-element", AbortablePartialContent);
export {
  AbortablePartialContent
};
