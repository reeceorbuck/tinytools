/**
 * Signal components for @tinytools/hono-tools: ready-made components whose
 * parts are placed and linked with `component.instance()`.
 *
 * ```tsx
 * const { component } = await tiny.imports(CounterSignalComponent);
 * const { CounterDisplay, Increment } = component.instance();
 * ```
 *
 * @module
 */

export { CounterSignalComponent } from "./Counter.tsx";
export { ListSignalComponent } from "./List.tsx";
