/**
 * JSX Runtime for @tinytools/hono-tools
 *
 * Extends Hono's JSX runtime with type-safe event handlers that require
 * client functions to be used. This prevents accidentally passing regular
 * functions as event handlers which would fail silently at runtime.
 *
 * @module
 */

/// <reference path="./navigation-api-types.d.ts" />

export {
  Fragment,
  jsx,
  jsxAttr,
  jsxEscape,
  jsxs,
  jsxTemplate,
} from "hono/jsx/jsx-runtime";
import type { JSX as HonoJSX } from "hono/jsx/jsx-runtime";
import type { ClientTools } from "./clientTools.ts";

/**
 * Brand symbol for ClientFunction types.
 * This is used to create a nominal type that distinguishes ClientFunction handlers
 * from regular functions at compile time.
 */
declare const ClientFunctionBrand: unique symbol;

/**
 * Brand symbol for "activated" client functions that have been registered via shared tools middleware.
 * Functions must be passed through tiny.middleware.sharedImports() to become usable in JSX event handlers.
 */
declare const ActivatedClientFunctionBrand: unique symbol;

/**
 * Error interface that appears in type errors for raw functions.
 * The interface name is intentionally descriptive to help users understand the error.
 */
interface ERROR_Raw_functions_cannot_be_used_as_event_handlers___Use_ClientTools_defineFunction_then_access_via_c_var_tools_clientFunctions {
  readonly [ClientFunctionBrand]: true;
  readonly [ActivatedClientFunctionBrand]: true;
}

/**
 * Error interface for non-activated ClientFunction.
 * The interface name explains how to fix the issue.
 */
interface ERROR_ClientFunction_not_activated___Access_from_c_var_tools_clientFunctions_not_from_factory {
  readonly [ActivatedClientFunctionBrand]: true;
}

/**
 * Branded type for client-side event handlers created via ClientTools.
 *
 * At runtime, these are actually strings (filenames), but TypeScript sees them as
 * functions with a brand. This prevents accidentally passing regular functions
 * as event handlers in JSX, which would fail silently at runtime.
 *
 * **IMPORTANT**: Client functions are "inactive" until registered via tiny.middleware.sharedImports() middleware.
 * In JSX, you must use the activated version from `c.var.tools.fn`,
 * NOT directly from the factory.
 *
 * **Common Error Fix:**
 * - ❌ `new ClientTools(url, { functions: {...} }).myHandler` → won't work
 * - ✅ `c.var.tools.fn.myHandler` → correct
 *
 * @example
 * ```ts
 * // Define tools
 * const tools = new ClientTools({
 *   functions: {
 *     handleClick() {
 *       console.log("clicked");
 *     },
 *   },
 * });
 *
 * // Use with middleware
 * app.use(tiny.middleware.sharedImports(tools));
 *
 * app.get("/", (c) => {
 *   const { fn } = c.var.tools;
 *   // ✅ Use fn from c.var.tools, not the factory
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
 * An "activated" ClientFunction that has been registered via tiny.middleware.sharedImports() middleware.
 * Only activated functions can be used as JSX event handlers.
 *
 * If you see an error about this type, check:
 * - Raw functions → wrap with ClientTools constructor's functions option
 * - Non-activated → access from c.var.tools.fn
 */
export type ActivatedClientFunction<
  // deno-lint-ignore no-explicit-any
  T extends (...args: any[]) => any = (...args: any[]) => any,
> =
  & T
  & ERROR_Raw_functions_cannot_be_used_as_event_handlers___Use_ClientTools_defineFunction_then_access_via_c_var_tools_clientFunctions;

/**
 * Helper type to brand a function type as a ClientFunction.
 * Used internally by ClientTools.
 *
 * Note: This type indicates a non-activated ClientFunction.
 * To use in JSX, access from c.var.tools.fn.
 */
// deno-lint-ignore no-explicit-any
export type BrandAsClientFunction<T extends (...args: any[]) => any> =
  ClientFunction<T>;

/**
 * Helper type to "activate" a ClientFunction, making it usable in JSX handlers.
 * Used internally by shared tools middleware when exposing fn via c.var.
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
     * Activate local component functions and merge them with context fn.
     * Returns a single proxy that should be used for all handler references in the component.
     */
    // deno-lint-ignore no-explicit-any
    extend<TLocal extends { [key: string]: any }>(
      localFactory: TLocal,
    ): ActivateClientFunctions<T & ActivateAllInFactory<TLocal>>;
  };

/**
 * Helper to extract and activate all functions from a ClientTools.
 * @internal
 */
// deno-lint-ignore no-explicit-any
type ActivateAllInFactory<T> = T extends ClientTools<infer A, any> ? A
  : never;

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
 * If you see a type error, you likely need to:
 * 1. Use ClientTools constructor with functions option instead of raw functions
 * 2. Access handlers from c.var.tools.fn (not factory)
 */
type ClientEventHandler<E extends Event> =
  // deno-lint-ignore no-explicit-any
  | ActivatedClientFunction<(this: any, event: E) => any>
  | undefined;

type ClientEventHandlerWithThis<E extends Event, T = HTMLElement> =
  | ActivatedClientFunction<(this: T, event: E) => void>
  | undefined;

// Define your global overrides here - now requiring branded ClientFunction types
interface GlobalOverrides {
  // Common events
  onCommand?: ClientEventHandler<CommandEvent>;

  // Window / document / navigation events (window-event-listener only)
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

  // Custom events for Navigation API
  // (kept above under window-event-listener-only group)
}

// Apply branded handler types to regular elements, but do NOT add window/navigation-only events.
type ElementEventOverrides = Omit<
  GlobalOverrides,
  | "onNavigate"
  | "onNavigateSuccess"
  | "onNavigateError"
  | "onCurrentEntryChange"
  | "onHashChange"
  | "onPopState"
  | "onResize"
  | "onOnline"
  | "onOffline"
  | "onMessage"
  | "onStorage"
  | "onVisibilityChange"
  | "onBeforeUnload"
  | "onUnload"
>;

type DisallowLifecycleEvents = {
  /**
   * Only <lifecycle-element> can use these.
   * Using them on normal elements should be a type error.
   */
  onMount?: ForbiddenProp<"Only <lifecycle-element> can use onMount">;
  onUnmount?: ForbiddenProp<"Only <lifecycle-element> can use onUnmount">;
};

type ForbiddenProp<Message extends string> = {
  /**
   * This property exists only to surface a readable compiler error.
   * It should never be provided at runtime.
   */
  __tsx_error_message__: Message;
};

/**
 * Helper type that shows an error when a non-activated ClientFunction is used.
 * At JSX attribute assignment time, this shows a readable hint about what went wrong.
 * @internal
 */
type ClientFunctionNotActivatedError = ForbiddenProp<
  "ClientFunction from defineFunctions() must be accessed from c.var.tools.fn after activation. Example: const { fn } = c.var.tools; <div onClick={fn.handlerName}>"
>;

/**
 * Helper type that shows an error when a raw function is used instead of a ClientFunction.
 * @internal
 */
type RawFunctionNotAllowedError = ForbiddenProp<
  "Raw functions cannot be used as event handlers. Use ClientTools constructor with functions option to define a handler, then access it from c.var.tools.fn after the handler is activated."
>;

type DisallowWindowOnlyEvents = {
  /**
   * Only <window-event-listener> can use these.
   * Using them on normal elements should be a type error.
   */
  onNavigate?: ForbiddenProp<"Only <window-event-listener> can use onNavigate">;
  onNavigateSuccess?: ForbiddenProp<
    "Only <window-event-listener> can use onNavigateSuccess"
  >;
  onNavigateError?: ForbiddenProp<
    "Only <window-event-listener> can use onNavigateError"
  >;
  onCurrentEntryChange?: ForbiddenProp<
    "Only <window-event-listener> can use onCurrentEntryChange"
  >;
  onHashChange?: ForbiddenProp<
    "Only <window-event-listener> can use onHashChange"
  >;
  onPopState?: ForbiddenProp<"Only <window-event-listener> can use onPopState">;
  onResize?: ForbiddenProp<"Only <window-event-listener> can use onResize">;
  onOnline?: ForbiddenProp<"Only <window-event-listener> can use onOnline">;
  onOffline?: ForbiddenProp<"Only <window-event-listener> can use onOffline">;
  onMessage?: ForbiddenProp<"Only <window-event-listener> can use onMessage">;
  onStorage?: ForbiddenProp<"Only <window-event-listener> can use onStorage">;
  onVisibilityChange?: ForbiddenProp<
    "Only <window-event-listener> can use onVisibilityChange"
  >;
  onBeforeUnload?: ForbiddenProp<
    "Only <window-event-listener> can use onBeforeUnload"
  >;
  onUnload?: ForbiddenProp<"Only <window-event-listener> can use onUnload">;
};

type ElementEventOverridesWithNoLifecycle =
  & ElementEventOverrides
  & DisallowLifecycleEvents;

type ElementEventOverridesStrict =
  & ElementEventOverridesWithNoLifecycle
  & DisallowWindowOnlyEvents;

type ElementEventOverridesNoWindowOnly =
  & ElementEventOverrides
  & DisallowWindowOnlyEvents;

type WindowEventOverrides = Pick<
  GlobalOverrides,
  | "onNavigate"
  | "onNavigateSuccess"
  | "onNavigateError"
  | "onCurrentEntryChange"
  | "onHashChange"
  | "onPopState"
  | "onResize"
  | "onOnline"
  | "onOffline"
  | "onMessage"
  | "onStorage"
  | "onVisibilityChange"
  | "onBeforeUnload"
  | "onUnload"
>;

type ApplyOverrides<TBase, TOverrides> =
  & Omit<TBase, keyof TOverrides>
  & TOverrides;

// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = HonoJSX.Element;
  export type IntrinsicAttributes = HonoJSX.IntrinsicAttributes;
  export type ElementChildrenAttribute = HonoJSX.ElementChildrenAttribute;

  export type IntrinsicElements =
    & {
      [K in keyof HonoJSX.IntrinsicElements]: ApplyOverrides<
        HonoJSX.IntrinsicElements[K],
        ElementEventOverridesStrict
      >;
    }
    & {
      /**
       * Custom element that can listen to global/window-level events.
       * Accepts normal element attributes, but event handlers must be activated client functions.
       */
      "window-event-listener": ApplyOverrides<
        HonoJSX.IntrinsicElements["div"],
        ElementEventOverridesWithNoLifecycle & WindowEventOverrides
      >;

      /**
       * Custom element that emits lifecycle events.
       * Accepts normal element attributes.
       */
      "lifecycle-element":
        & ApplyOverrides<
          HonoJSX.IntrinsicElements["div"],
          ElementEventOverridesNoWindowOnly
        >
        & {
          onMount?: ClientEventHandler<Event>;
          onUnmount?: ClientEventHandler<Event>;
        };
    };
}

declare global {
  interface CommandEvent extends Event {
    source: HTMLButtonElement;
    command: string;
  }
}
