const contextKey = /* @__PURE__ */ Symbol.for("tinytools.partialContentContexts");
const contextGlobal = globalThis;
const contexts = contextGlobal[contextKey] ??= /* @__PURE__ */ new WeakMap();
function setPartialContentContext(element, context) {
  contexts.set(element, context);
}
function getPartialContentContext(element) {
  return contexts.get(element);
}
export {
  getPartialContentContext,
  setPartialContentContext
};
