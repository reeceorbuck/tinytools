/**
 * JSX Runtime for @tinytools/hono-tools
 *
 * Extends Hono's JSX runtime with type-safe event handlers that require
 * client functions to be used. This prevents accidentally passing regular
 * functions as event handlers which would fail silently at runtime.
 *
 * Lifecycle handlers (`onConnect`, `onDisconnect`, and `onLoad` where only the
 * browser fires it) are bound at render time (see lifecycleBindings.ts): a custom tag
 * is declared as a lifecycle tag without any wrapper, a plain tag without an
 * `is` gets one so it becomes a customized built-in, a plain tag that needs
 * an `<upgrade-preceding>` proxy is marked, and placing a marked element
 * inside another element throws, so a forgotten `UpgradeCustomElement`
 * fails at render time rather than silently never firing.
 *
 * @module
 */

export { Fragment, jsxEscape } from "hono/jsx/jsx-runtime";
import {
  jsx as honoJsx,
  jsxAttr as honoJsxAttr,
  jsxTemplate as honoJsxTemplate,
} from "hono/jsx/jsx-runtime";
import {
  type HandlerReference,
  handlerReferenceAttributes,
} from "./eventAttributes.ts";
import {
  markElementNode,
  type ProxyNeed,
  type ValueSlot,
  withTemplateRoots,
  wrapComponent,
} from "./componentScope.ts";
import {
  automaticLifecycleIs,
  findUnproxied,
  lifecycleAttributeEvent,
  lifecycleEvent,
  lifecycleHandlerNeedsProxy,
  markLifecycleAttribute,
  markNeedsProxy,
  unproxiedLifecycleError,
} from "./lifecycleBindings.ts";

/**
 * Applies the lifecycle rules to a precompiled template's values: each
 * attribute value from `jsxAttr` is bound to the open tag it sits in, and a
 * child value still waiting for a proxy may only sit beside the top-level
 * content. Returns the proxy need the template as a whole carries, if any.
 */
function inspectTemplate(
  values: unknown[],
  slots: readonly ValueSlot[],
): ProxyNeed | undefined {
  let need: ProxyNeed | undefined;
  /** The `is` added to each element that had none, by element index. */
  const added = new Map<number, string>();
  // An `is` bound dynamically is another attribute value of the same tag.
  const dynamicIs = (slot: ValueSlot): string | undefined => {
    for (const [index, other] of slots.entries()) {
      if (other?.element !== slot.element) continue;
      const match = /^is="([^"]*)"$/.exec(String(values[index]));
      if (match) return match[1];
    }
  };
  values.forEach((value, index) => {
    const event = lifecycleAttributeEvent(value);
    if (event) {
      const slot = slots[index];
      if (!slot.tag) return;
      let is = slot.is ?? added.get(slot.element!) ?? dynamicIs(slot);
      const automatic = automaticLifecycleIs(slot.tag, event, is);
      if (automatic) {
        // Rendered with the handler attribute, so it lands in the same tag.
        values[index] = honoJsxTemplate`${
          honoJsxAttr("is", automatic)
        } ${value}`;
        added.set(slot.element!, automatic);
        is = automatic;
      }
      if (!lifecycleHandlerNeedsProxy(slot.tag, event, is)) return;
      // Nested in the same markup, so no wrapper can ever follow it.
      if (slot.depth > 0) {
        throw unproxiedLifecycleError({ tag: slot.tag, event });
      }
      need = { tag: slot.tag, event };
      return;
    }
    const nested = findUnproxied(value);
    if (!nested) return;
    // Inside an element nothing can proxy it; beside top-level content (a
    // fragment, say) the template as a whole can still be wrapped.
    if (slots[index].depth > 0) throw unproxiedLifecycleError(nested);
    need ??= nested;
  });
  return need;
}

export const jsxTemplate: typeof honoJsxTemplate = withTemplateRoots(
  honoJsxTemplate,
  inspectTemplate,
);

export const jsx: typeof honoJsx = (tag, props, key) => {
  if (typeof tag === "function") {
    return honoJsx(wrapComponent(tag as (props: never) => unknown), props, key);
  }
  if (!props) return markElementNode(honoJsx(tag, props, key));
  let expanded = props;
  let need: ProxyNeed | undefined;
  for (const [name, value] of Object.entries(props)) {
    const attributes = handlerReferenceAttributes(name, value);
    if (!attributes) continue;
    if (expanded === props) expanded = { ...props };
    delete expanded[name];
    Object.assign(expanded, attributes);
    if (tag === "link" && "onload" in attributes) {
      expanded.onLoad = attributes.onload;
      delete expanded.onload;
    }
    const event = Object.keys(attributes).length
      ? lifecycleEvent(name)
      : undefined;
    if (!event) continue;
    const automatic = automaticLifecycleIs(tag, event, expanded.is);
    if (automatic) expanded.is = automatic;
    if (lifecycleHandlerNeedsProxy(tag, event, expanded.is)) {
      need = { tag, event };
    }
  }
  const nested = findUnproxied(props.children);
  if (nested) throw unproxiedLifecycleError(nested);
  const node = markElementNode(honoJsx(tag, expanded, key));
  return need ? markNeedsProxy(node, need) : node;
};

export const jsxs: typeof honoJsx = jsx;

export const jsxAttr = (
  name: string,
  value:
    | Parameters<typeof honoJsxAttr>[1]
    | HandlerReference<string, unknown>
    | readonly HandlerReference<string, unknown>[],
): ReturnType<typeof honoJsxAttr> => {
  const attributes = handlerReferenceAttributes(name, value);
  if (!attributes) {
    return honoJsxAttr(name, value as Parameters<typeof honoJsxAttr>[1]);
  }
  const [eventAttribute, handlerAttribute] = Object.entries(attributes);
  if (!eventAttribute) return honoJsxTemplate``;
  const rendered = handlerAttribute
    ? honoJsxTemplate`${honoJsxAttr(...eventAttribute as [string, string])} ${
      honoJsxAttr(...handlerAttribute as [string, string])
    }`
    : honoJsxAttr(...eventAttribute as [string, string]);
  const event = lifecycleEvent(name);
  return event ? markLifecycleAttribute(rendered, event) : rendered;
};

import type { JSX as HonoJSX } from "hono/jsx/jsx-runtime";
import type { IncomingDataEvent } from "./handlers/processIncomingData.ts";

/**
 * Brand symbol for ClientFunction types.
 * This is used to create a nominal type that distinguishes ClientFunction handlers
 * from regular functions at compile time.
 */
declare const ClientFunctionBrand: unique symbol;

/**
 * Brand symbol for inline client expressions returned by tiny.imports().
 */
declare const ActivatedClientFunctionBrand: unique symbol;

/**
 * Error interface that appears in type errors for raw functions.
 * The interface name is intentionally descriptive to help users understand the error.
 */
interface ERROR_Raw_functions_cannot_be_used_as_event_handlers___Use_tiny_imports {
  readonly [ClientFunctionBrand]: true;
  readonly [ActivatedClientFunctionBrand]: true;
}

/**
 * Branded type for client-side event handlers created via ClientTools.
 *
 * At runtime, these are actually strings (filenames), but TypeScript sees them as
 * functions with a brand. This prevents accidentally passing regular functions
 * as event handlers in JSX, which would fail silently at runtime.
 *
 * In JSX, use references returned by `await tiny.imports(tools)`,
 * NOT directly from the factory.
 *
 * **Common Error Fix:**
 * - ❌ `new tiny.Handlers(url, {...}).myHandler` → won't work
 * - ✅ `(await tiny.imports(tools)).fn.myHandler` → correct
 *
 * @example
 * ```ts
 * // Define handlers
 * const handlers = new tiny.Handlers(import.meta.url, {
 *   handleClick() {
 *     console.log("clicked");
 *   },
 * });
 *
 * app.get("/", async (c) => {
 *   const { fn } = await tiny.imports(handlers);
 *   return <div onClick={fn.handleClick}>Click me</div>;
 * });
 * ```
 */
export type ClientFunction<
  // deno-lint-ignore no-explicit-any
  T extends (...args: any[]) => any = (...args: any[]) => any,
> = T & {
  readonly [ClientFunctionBrand]: true;
};

/**
 * An inline client expression returned by tiny.imports().handlers.
 *
 * If you see an error about this type, check:
 * - Raw functions → wrap with ClientTools constructor's functions option
 * - Non-activated → access through tiny.imports()
 */
export type ActivatedClientFunction<
  // deno-lint-ignore no-explicit-any
  T extends (...args: any[]) => any = (...args: any[]) => any,
> =
  & T
  & ERROR_Raw_functions_cannot_be_used_as_event_handlers___Use_tiny_imports;

/**
 * Helper type to brand a function type as a ClientFunction.
 * Used internally by ClientTools.
 *
 * Note: This type indicates a non-activated ClientFunction.
 * To use in JSX, import the collection with tiny.imports().
 */
// deno-lint-ignore no-explicit-any
export type BrandAsClientFunction<T extends (...args: any[]) => any> =
  ClientFunction<T>;

/**
 * Helper type to "activate" a ClientFunction, making it usable in JSX handlers.
 * Used internally by tiny.imports() for inline handler expressions.
 * Also handles raw function types by treating them as activatable.
 */
// deno-lint-ignore no-explicit-any
export type ActivateClientFunction<T> = T extends (...args: any[]) => any
  ? ActivatedClientFunction<T>
  : T;

/**
 * Helper type to activate all client functions in an object.
 * Transforms { foo: ClientFunction<F> } to { foo: ActivatedClientFunction<F> }
 * Also includes the `activate` method for merging local component functions.
 */
export type ActivateClientFunctions<T> =
  & {
    [K in keyof T]: ActivateClientFunction<T[K]>;
  }
  & {
    /**
     * Compose activated handlers that execute independently without waiting
     * for one another.
     */
    multiHandler(
      ...handlers: ActivatedClientFunction[]
    ): ActivatedClientFunction;

    /**
     * Compose activated handlers in order. Each handler is awaited, and later
     * handlers are skipped when an earlier handler returns false.
     */
    multiHandlerSync(
      ...handlers: ActivatedClientFunction[]
    ): ActivatedClientFunction;
  };

/**
 * Type guard to check if a value is a ClientFunction at the type level.
 * Note: At runtime, client functions are actually strings, so this is purely for type narrowing.
 */
export type IsClientFunction<T> = T extends ClientFunction<infer _F> ? true
  : false;

// ============================================================================
// Event Handler Types with Descriptive Error Messages
// ============================================================================

/**
 * Event handler type for JSX attributes. Must be an activated ClientFunction.
 *
 * The handler's event parameter type is checked via natural contravariance:
 * a handler accepting `Event` is valid for any specific event (e.g., `onSubmit`),
 * while a handler accepting `MouseEvent` would be rejected for `onSubmit`.
 *
 * The `this` parameter remains broad so element-specific handlers can still be
 * passed through JSX without forcing every intrinsic prop to model its exact
 * receiver element type.
 *
 * If you see a type error, you likely need to:
 * 1. Use ClientTools constructor with functions option instead of raw functions
 * 2. Access handlers through tiny.imports() (not the factory)
 */
type ClientEventHandler<E extends Event> =
  // deno-lint-ignore no-explicit-any
  | ActivatedClientFunction<(this: any, event: E) => void>
  | HandlerReference<string, (event: E) => unknown>
  | readonly HandlerReference<string, (event: E) => unknown>[]
  | undefined;

// Define your global overrides here - now requiring branded ClientFunction types
interface GlobalOverrides {
  // Common events
  onCommand?: ClientEventHandler<CommandEvent>;

  /**
   * Fired once by `ActivateParsedHandler` when the element and its content
   * have been parsed; unlike `onConnect` it never repeats on reconnection.
   */
  onParsed?: ClientEventHandler<Event>;

  // Window / document / navigation events
  onNavigate?: ClientEventHandler<NavigateEvent>;
  onNavigateSuccess?: ClientEventHandler<Event>;
  onNavigateError?: ClientEventHandler<ErrorEvent>;
  onCurrentEntryChange?: ClientEventHandler<NavigationCurrentEntryChangeEvent>;
  onHashChange?: ClientEventHandler<HashChangeEvent>;
  onPopState?: ClientEventHandler<PopStateEvent>;
  onResize?: ClientEventHandler<UIEvent>;
  onOnline?: ClientEventHandler<Event>;
  onOffline?: ClientEventHandler<Event>;
  onMessage?: ClientEventHandler<MessageEvent>;
  onIncomingData?: ClientEventHandler<IncomingDataEvent>;
  onStorage?: ClientEventHandler<StorageEvent>;
  onVisibilityChange?: ClientEventHandler<Event>;
  onBeforeUnload?: ClientEventHandler<BeforeUnloadEvent>;
  onUnload?: ClientEventHandler<Event>;

  // Form events
  onSubmit?: ClientEventHandler<SubmitEvent>;
  onReset?: ClientEventHandler<Event>;
  onChange?: ClientEventHandler<Event>;
  onInput?: ClientEventHandler<Event>;
  onInvalid?: ClientEventHandler<Event>;

  // Mouse events
  onClick?: ClientEventHandler<MouseEvent>;
  onDblClick?: ClientEventHandler<MouseEvent>;
  onMouseDown?: ClientEventHandler<MouseEvent>;
  onMouseUp?: ClientEventHandler<MouseEvent>;
  onMouseEnter?: ClientEventHandler<MouseEvent>;
  onMouseLeave?: ClientEventHandler<MouseEvent>;
  onMouseOver?: ClientEventHandler<MouseEvent>;
  onMouseOut?: ClientEventHandler<MouseEvent>;
  onMouseMove?: ClientEventHandler<MouseEvent>;
  onContextMenu?: ClientEventHandler<MouseEvent>;

  // Keyboard events
  onKeyDown?: ClientEventHandler<KeyboardEvent>;
  onKeyUp?: ClientEventHandler<KeyboardEvent>;
  onKeyPress?: ClientEventHandler<KeyboardEvent>;

  // Focus events
  onFocus?: ClientEventHandler<FocusEvent>;
  onBlur?: ClientEventHandler<FocusEvent>;
  onFocusIn?: ClientEventHandler<FocusEvent>;
  onFocusOut?: ClientEventHandler<FocusEvent>;

  // Drag events
  onDrag?: ClientEventHandler<DragEvent>;
  onDragStart?: ClientEventHandler<DragEvent>;
  onDragEnd?: ClientEventHandler<DragEvent>;
  onDragEnter?: ClientEventHandler<DragEvent>;
  onDragLeave?: ClientEventHandler<DragEvent>;
  onDragOver?: ClientEventHandler<DragEvent>;
  onDrop?: ClientEventHandler<DragEvent>;

  // Touch events
  onTouchStart?: ClientEventHandler<TouchEvent>;
  onTouchEnd?: ClientEventHandler<TouchEvent>;
  onTouchMove?: ClientEventHandler<TouchEvent>;
  onTouchCancel?: ClientEventHandler<TouchEvent>;

  // Pointer events
  onPointerDown?: ClientEventHandler<PointerEvent>;
  onPointerUp?: ClientEventHandler<PointerEvent>;
  onPointerMove?: ClientEventHandler<PointerEvent>;
  onPointerEnter?: ClientEventHandler<PointerEvent>;
  onPointerLeave?: ClientEventHandler<PointerEvent>;
  onPointerOver?: ClientEventHandler<PointerEvent>;
  onPointerOut?: ClientEventHandler<PointerEvent>;
  onPointerCancel?: ClientEventHandler<PointerEvent>;
  onGotPointerCapture?: ClientEventHandler<PointerEvent>;
  onLostPointerCapture?: ClientEventHandler<PointerEvent>;

  // Wheel events
  onWheel?: ClientEventHandler<WheelEvent>;
  onScroll?: ClientEventHandler<Event>;

  // Animation events
  onAnimationStart?: ClientEventHandler<AnimationEvent>;
  onAnimationEnd?: ClientEventHandler<AnimationEvent>;
  onAnimationIteration?: ClientEventHandler<AnimationEvent>;

  // Transition events
  onTransitionEnd?: ClientEventHandler<TransitionEvent>;

  // Clipboard events
  onCopy?: ClientEventHandler<ClipboardEvent>;
  onCut?: ClientEventHandler<ClipboardEvent>;
  onPaste?: ClientEventHandler<ClipboardEvent>;

  // Media events
  onPlay?: ClientEventHandler<Event>;
  onPause?: ClientEventHandler<Event>;
  onEnded?: ClientEventHandler<Event>;
  onLoadedData?: ClientEventHandler<Event>;
  onLoadedMetadata?: ClientEventHandler<Event>;
  onTimeUpdate?: ClientEventHandler<Event>;
  onVolumeChange?: ClientEventHandler<Event>;
  onSeeking?: ClientEventHandler<Event>;
  onSeeked?: ClientEventHandler<Event>;
  onRateChange?: ClientEventHandler<Event>;
  onDurationChange?: ClientEventHandler<Event>;
  onProgress?: ClientEventHandler<ProgressEvent>;
  onCanPlay?: ClientEventHandler<Event>;
  onCanPlayThrough?: ClientEventHandler<Event>;
  onWaiting?: ClientEventHandler<Event>;
  onStalled?: ClientEventHandler<Event>;
  onSuspend?: ClientEventHandler<Event>;
  onEmptied?: ClientEventHandler<Event>;

  // Image/resource events
  onLoad?: ClientEventHandler<Event>;
  onError?: ClientEventHandler<Event | ErrorEvent>;
  onAbort?: ClientEventHandler<Event>;

  // Selection events
  onSelect?: ClientEventHandler<Event>;
  onSelectionChange?: ClientEventHandler<Event>;

  // Toggle events (for details/dialog)
  onToggle?: ClientEventHandler<Event>;
}

type ElementEventOverridesStrict =
  & GlobalOverrides
  & {
    onMount?: never;
    onUnmount?: never;
  };

type ApplyOverrides<TBase, TOverrides> =
  & Omit<TBase, keyof TOverrides>
  & TOverrides;

// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = HonoJSX.Element;
  export type IntrinsicAttributes = HonoJSX.IntrinsicAttributes;
  export type ElementChildrenAttribute = HonoJSX.ElementChildrenAttribute;

  export type IntrinsicElements = {
    [K in keyof HonoJSX.IntrinsicElements]: ApplyOverrides<
      HonoJSX.IntrinsicElements[K],
      ElementEventOverridesStrict
    >;
  };
}
