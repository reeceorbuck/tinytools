const windowEventMap = {
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
    eventName: "visibilitychange"
  },
  onfocus: { target: globalThis, eventName: "focus" },
  onblur: { target: globalThis, eventName: "blur" },
  onerror: { target: globalThis, eventName: "error" },
  // Navigation API events
  onnavigate: { target: globalThis.navigation, eventName: "navigate" },
  onnavigatesuccess: {
    target: globalThis.navigation,
    eventName: "navigatesuccess"
  },
  onnavigateerror: {
    target: globalThis.navigation,
    eventName: "navigateerror"
  },
  oncurrententrychange: {
    target: globalThis.navigation,
    eventName: "currententrychange"
  }
};
customElements.define(
  "window-event-listener",
  class extends HTMLElement {
    abortController = null;
    targetElements = [];
    replacedSelf = false;
    connectedCallback() {
      this.targetElements = Array.from(this.children);
      this.setupEventListeners();
      this.copyHandlerAttributesToChildren();
      this.replacedSelf = true;
      this.replaceWithChildren();
    }
    disconnectedCallback() {
      if (this.replacedSelf) return;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    }
    replaceWithChildren() {
      const parent = this.parentNode;
      if (!parent) return;
      while (this.firstChild) {
        parent.insertBefore(this.firstChild, this);
      }
      parent.removeChild(this);
    }
    copyHandlerAttributesToChildren() {
      for (const attr of Array.from(this.attributes)) {
        const attrNameLower = attr.name.toLowerCase();
        if (!attrNameLower.startsWith("on")) continue;
        if (!windowEventMap[attrNameLower]) continue;
        for (const child of this.targetElements) {
          child.setAttribute(attr.name, attr.value);
        }
      }
    }
    setupEventListeners() {
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
        const handlerName = attr.value.match(/^handlers\.([^(]+)\(/)?.[1];
        if (!handlerName) continue;
        this.addWindowEventListener(eventConfig, handlerName, signal);
      }
    }
    addWindowEventListener(eventConfig, handlerName, signal) {
      const { target, eventName } = eventConfig;
      const targetElements = this.targetElements;
      target.addEventListener(
        eventName,
        (event) => {
          for (const element of targetElements) {
            globalThis.handlers[handlerName](element, event);
          }
        },
        { signal }
      );
      console.log(
        `[window-event-listener] Added ${eventName} listener for handler "${handlerName}" (${targetElements.length} target elements)`
      );
    }
  }
);
