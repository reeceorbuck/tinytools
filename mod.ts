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
 * const routeHandlers = new tiny.Handlers({
 *   handleClick(e: MouseEvent) {
 *     console.log("Clicked!", e);
 *   },
 * });
 *
 * const routeStyles = new tiny.Styles({ buttonStyle });
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
  optimized,
  type RouteLayoutComponent,
  type RouteLayoutProps,
  tiny,
  type TinyHonoOptions,
} from "./honoFactory.tsx";
export type { PartialAbortableHTMLElement } from "./components/ActivateOnLoadHandler.tsx";
export type { LifecycleElement } from "./lifecycleElement.ts";

// Handlers & Styles exports
export {
  type ComponentInstances,
  type ComponentLinker,
  Constants,
  Handlers,
  type ImportedComponent,
  type ImportedTools,
  imports,
  type Instance,
  type Instanced,
  type InstancedComponent,
  type RenderedTemplate,
  SignalComponent,
  type SignalComponentTools,
  Signals,
  Styles,
  type TemplateClones,
  type TemplateFragment,
  type TemplateParams,
  Templates,
} from "./clientTools.ts";
export type {
  InstanceDefinitions,
  InstanceLevels,
  InstanceSeed,
  InstanceSignal,
  InstanceSignals,
  ReadonlySignal,
  Signal,
  SignalAccessors,
  SignalConstant,
  SignalConstants,
  SignalDefinitions,
  SignalTools,
  SignalValue,
  Trigger,
} from "./signals.ts";
// Registry exports (used by build process)
export {
  eventHandlerBody,
  type HandlerProp,
  type HandlerReference,
  type HandlerReferences,
  type SignalProp,
} from "./eventAttributes.ts";
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

// Performance utilities
export { logStartupPerformanceSummary } from "./startupPerformanceSummary.ts";

// Development utilities
export { checkDefinitionImportsNow } from "./clientTools.ts";
export {
  logUnusedImports,
  type UnusedImports,
  unusedImports,
} from "./importUsage.ts";

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
