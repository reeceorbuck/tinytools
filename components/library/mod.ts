/**
 * Signal components for @tinytools/hono-tools: ready-made components whose
 * parts are placed and linked with `component.instance()`.
 *
 * ```tsx
 * const { component } = await tiny.imports(CounterSignalComponent);
 * const counter = component.instance();
 *
 * <counter.Increment by={1} />
 * <counter.CounterDisplay />
 * ```
 *
 * @module
 */

export { CounterSignalComponent } from "./Counter.tsx";
export { DatePickerSignalComponent } from "./DatePicker.tsx";
export { DialogSignalComponent } from "./Dialog.tsx";
export { DisclosureSignalComponent } from "./Disclosure.tsx";
export { ListSignalComponent } from "./List.tsx";
export { SearchFilterSignalComponent } from "./SearchFilter.tsx";
