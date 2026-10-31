/**
 * JSX dev runtime for @tinytools/hono-tools
 *
 * Re-exports the package's JSX runtime as `jsxDEV`, so development builds
 * get the same type-safe event handlers, signal bindings and lifecycle
 * binding as production builds.
 *
 * @module
 */

export { Fragment, jsx as jsxDEV } from "./jsx-runtime.ts";
export type { JSX } from "./jsx-runtime.ts";
