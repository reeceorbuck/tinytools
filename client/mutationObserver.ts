/**
 * Mutation Observer client script for @tiny-tools/hono
 *
 * Provides mutation observer functionality for handling dynamic DOM updates.
 * Currently disabled by default - can be enabled for automatic handler cleanup.
 */

import type { HandlerProxy } from "./eventHandlers.ts";

interface SymbolIndexedElement extends Element {
  [key: symbol]: AbortController | undefined;
}

const EVENT_ABORT_CONTROLLER_SYM = Symbol.for("__event_AbortController");
const GLOBAL_EVENT_NAMES_SYM = Symbol.for("__globalEventNames");

const GLOBAL_EVENT_TARGETS: Record<string, EventTarget | undefined> = {
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
  visibilitychange: globalThis.document,
};

function cleanupGlobalEventListenerState(el: Element) {
  const symEl = el as SymbolIndexedElement;
  const controller = symEl[EVENT_ABORT_CONTROLLER_SYM];
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }

  const eventNames = (symEl as unknown as Record<symbol, unknown>)[
    GLOBAL_EVENT_NAMES_SYM
  ] as Set<string> | undefined;

  if (eventNames) {
    for (const eventName of eventNames) {
      delete symEl[Symbol.for(`__${eventName}_AbortController`)];
    }
    delete (symEl as unknown as Record<symbol, unknown>)[
      GLOBAL_EVENT_NAMES_SYM
    ];
  }

  delete symEl[EVENT_ABORT_CONTROLLER_SYM];
}

// Note: Mutation observer is currently disabled
// Uncomment below to enable automatic handler processing on DOM changes

// new MutationObserver((mutations) => {
//   const addedHandlerArray = mutations
//     .flatMap((m) =>
//       Array.from(m.addedNodes).flatMap((node) =>
//         Array.from((node as Element).querySelectorAll("*"))
//       )
//     ).flatMap((element) =>
//       Array.from(element.attributes)
//         .filter((attr) => attr.name.startsWith("on"))
//         .map((attr) => ({ attr, element }))
//     );
//
//   const removedElements = mutations
//     .flatMap((m) =>
//       Array.from(m.removedNodes).flatMap((node) =>
//         Array.from((node as Element).querySelectorAll("*"))
//       )
//     ).map((el) => {
//       cleanupGlobalEventListenerState(el);
//       return el;
//     });
// }).observe(document, {
//   childList: true,
//   subtree: true,
//   characterData: false,
// });

export { cleanupGlobalEventListenerState, GLOBAL_EVENT_TARGETS };
