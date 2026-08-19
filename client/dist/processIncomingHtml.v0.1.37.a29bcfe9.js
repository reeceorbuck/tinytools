import {
  setPartialContentContext
} from "./partialContentContext.v0.1.37.cd97d5bb.js";
function processIncomingHtml(fragment, scope = document, options = {}) {
  const incomingElements = Array.from(fragment.children);
  const context = {
    scope,
    options,
    incomingElements,
    state: /* @__PURE__ */ new Set()
  };
  for (const incoming of incomingElements) {
    if (incoming.tagName === "PARTIAL-CONTENT") {
      setPartialContentContext(incoming, context);
      document.body.appendChild(incoming);
      continue;
    }
    if (incoming.tagName === "SCRIPT") {
      document.body.appendChild(incoming);
      continue;
    }
    console.error(
      `Ignoring unexpected incoming <${incoming.tagName.toLowerCase()}>; body updates must use <partial-content>.`
    );
  }
}
export {
  processIncomingHtml
};
