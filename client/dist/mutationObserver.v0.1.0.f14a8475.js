const EVENT_ABORT_CONTROLLER_SYM = /* @__PURE__ */ Symbol.for("__event_AbortController");
const GLOBAL_EVENT_NAMES_SYM = /* @__PURE__ */ Symbol.for("__globalEventNames");
const GLOBAL_EVENT_TARGETS = {
  // Navigation API events
  navigatesuccess: globalThis.navigation,
  navigateerror: globalThis.navigation,
  currententrychange: globalThis.navigation,
  // Window events
  hashchange: globalThis,
  resize: globalThis,
  online: globalThis,
  offline: globalThis,
  message: globalThis,
  storage: globalThis,
  // Document events
  visibilitychange: globalThis.document
};
function cleanupGlobalEventListenerState(el) {
  const symEl = el;
  const controller = symEl[EVENT_ABORT_CONTROLLER_SYM];
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  const eventNames = symEl[GLOBAL_EVENT_NAMES_SYM];
  if (eventNames) {
    for (const eventName of eventNames) {
      delete symEl[/* @__PURE__ */ Symbol.for(`__${eventName}_AbortController`)];
    }
    delete symEl[GLOBAL_EVENT_NAMES_SYM];
  }
  delete symEl[EVENT_ABORT_CONTROLLER_SYM];
}
export {
  GLOBAL_EVENT_TARGETS,
  cleanupGlobalEventListenerState
};
