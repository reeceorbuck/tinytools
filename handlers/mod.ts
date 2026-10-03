/**
 * Browser handler collections shipped with @tinytools/hono-tools.
 *
 * Import a collection with `tiny.imports()` to bind its handlers in JSX; only
 * the bundles of handlers actually accessed are loaded by the page.
 *
 * @module
 */

export {
  applyNavigationHandlers,
  type AppNavigation,
  navigationTools,
} from "./navigationTools.ts";
export {
  type IncomingData,
  type IncomingDataEvent,
  processIncomingDataTools,
} from "./processIncomingData.ts";
export { partialInsertHandlers } from "./partialInsertHandlers.ts";
export {
  type SignalElement,
  type SignalEvent,
  signalTools,
} from "./signals.ts";
export { sseTools } from "./sseTools.ts";
export { queryParamTools } from "./queryParams.ts";
