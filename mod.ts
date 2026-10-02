performance.mark("import:@tinytools/hono-tools:start");
/**
 * @module @tinytools/hono-tools
 *
 * A lightweight enhancement layer for Hono web applications.
 * Provides type-safe client functions, scoped styles, and enhanced JSX event handlers.
 *
 * @example Basic Usage with Handlers and Styles
 * ```ts
 * import { Hono } from "hono";
 * import { tiny, css } from "@tinytools/hono-tools";
 *
 * const buttonStyle = css`
 *   background: blue;
 *   color: white;
 * `;
 *
 * const routeHandlers = new tiny.Handlers(import.meta.url, {
 *   handleClick(e: MouseEvent) {
 *     console.log("Clicked!", e);
 *   },
 * });
 *
 * const routeStyles = new tiny.Styles(import.meta.url, { buttonStyle });
 *
 * const app = new Hono()
 *   .use(...tiny.middleware.core());
 *
 * app.get("/", async (c) => {
 *   const { fn, styled } = await tiny.imports(routeHandlers, routeStyles);
 *   return c.render(
 *     <button class={styled.buttonStyle} onClick={fn.handleClick}>
 *       Click me
 *     </button>
 *   );
 * });
 * ```
 */

// Core setup and middleware exports
export {
  type ClientToolsOptions,
  type RouteLayoutComponent,
  type RouteLayoutProps,
  tiny,
  type TinyHonoOptions,
} from "./honoFactory.tsx";
export type { PartialAbortableHTMLElement } from "./components/ActivateOnLoadHandler.tsx";

// Handlers & Styles exports
export {
  Handlers,
  type HandlersOptions,
  type ImportedTools,
  imports,
  Signals,
  Store,
  Styles,
} from "./clientTools.ts";
export type {
  ReadonlySignal,
  Signal,
  SignalAccessors,
  SignalDefinitions,
  SignalTools,
  SignalValue,
} from "./signals.ts";
// Registry exports (used by build process)
export {
  eventHandlerBody,
  type Events,
  type HandlerProp,
  type HandlerReference,
  type HandlerReferences,
} from "./eventAttributes.ts";
export { handlers } from "./clientFunctions.ts";
export {
  css,
  mergeClassNames,
  scopedStylesRegistry,
  setCustomScope,
} from "./scopedStyles.ts";

export {
  component,
  COMPONENT_ROOT_ATTRIBUTE,
  transparent,
} from "./componentScope.ts";

// Type exports for activated styles
export type { ActivateScopedStyles } from "./scopedStyles.ts";

// Type exports from JSX runtime
export type {
  ActivateClientFunction,
  ActivateClientFunctions,
  ActivatedClientFunction,
  BrandAsClientFunction,
  ClientFunction,
  IsClientFunction,
} from "./jsx-runtime.ts";

// Performance utilities
export { logStartupPerformanceSummary } from "./startupPerformanceSummary.ts";

// Server-sent event utilities
export {
  type SendUpdateOptions,
  sendUpdateStream,
  type UpdateStreamApi,
} from "./sendUpdates.tsx";
export {
  activeStreams,
  addStream,
  getDisplayedPath,
  getStreamDataById,
  getStreamsMatchingPaths,
  getTrackedStreamPaths,
  removeStream,
  setInactiveStream,
  SSE_ID_COOKIE,
  type StreamData,
  type StreamEventMap,
  streamEvents,
  streamHasExactPath,
  streamHasMatchingPath,
  streamHasPathPattern,
  streamHasPathPrefix,
  trackConnectedClients,
  updateStreamPath,
} from "./sse.ts";

// Route metadata helper
export { titled } from "./titled.ts";
export { urlStyleVariables } from "./urlStyleVariables.ts";

// Re-export JSX namespace for consumers
export type { JSX } from "./jsx-runtime.ts";
