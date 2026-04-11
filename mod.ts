performance.mark("import:@tinytools/hono-tools:start");
/**
 * @module @tinytools/hono-tools
 *
 * A lightweight enhancement layer for Hono web applications running on Deno.
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
 *   .use(...tiny.middleware.all())
 *   .use(tiny.middleware.sharedImports(routeHandlers, routeStyles));
 *
 * app.get("/", (c) => {
 *   const { fn, styled } = c.var.tools;
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
  addGlobalStyles,
  addRouteLayout,
  type BaseTools,
  type ClientToolsOptions,
  getTools,
  type InferTools,
  type LocalRoutesOptions,
  type NavApiToolsOptions,
  type RouteLayoutProps,
  type SseToolsOptions,
  tiny,
  type TinyToolsVariables,
  type WebComponentsOptions,
  type withAncestors,
  withLayoutTools,
} from "./honoFactory.tsx";

// Handlers & Styles exports
export {
  type ActivatedClientTools,
  Handlers,
  type HandlersOptions,
  imports,
  Styles,
  type StylesOptions,
} from "./clientTools.ts";

// Registry exports (used by build process)
export { handlers } from "./clientFunctions.ts";
export {
  css,
  mergeClassNames,
  scopedStylesRegistry,
  setCustomScope,
} from "./scopedStyles.ts";

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

// Stream update utilities
export {
  lastUpdated,
  sendUpdateStream,
  type UpdateStreamApi,
} from "./sendUpdates.tsx";
export {
  activeStreams,
  addStream,
  getStreamDataById,
  getTrackedStreamPaths,
  removeStream,
  setInactiveStream,
  type StreamData,
  streamEvents,
  streamHasExactPath,
  streamHasMatchingPath,
  streamHasPathPrefix,
  trackConnectedClients,
  updateStreamPath,
} from "./sse.ts";

// Route metadata helper
export { titled } from "./titled.ts";

// Re-export JSX namespace for consumers
export type { JSX } from "./jsx-runtime.ts";

declare global {
  var navigation: Navigation;
}
