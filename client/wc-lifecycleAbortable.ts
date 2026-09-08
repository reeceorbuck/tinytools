/// <reference lib="dom" />

export class AbortablePartialContent extends HTMLElement {
  abortController: AbortController | undefined;

  constructor() {
    super();
    console.log("New AbortablePartialContent constructed");
  }

  connectedCallback() {
    this.dispatchEvent(new Event("load"));
  }

  disconnectedCallback() {
    this.dispatchEvent(new Event("suspend"));
    //this.abortController?.abort();
    // console.log(
    //   "AbortablePartialContent disconnected, abortController aborted if it existed",
    // );
  }
}

customElements.define("abortable-lifecycle-element", AbortablePartialContent);

export type PartialAbortableHTMLElement = AbortablePartialContent;

// If we use this and move it between a template where it is inactive and the document
// we will need to run the onLoad event repeatedly. Which means it can't be removed after running once
