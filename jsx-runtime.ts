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

export { Fragment } from "hono/jsx/jsx-runtime";
import {
  Fragment,
  jsx as honoJsx,
  jsxAttr as honoJsxAttr,
  jsxEscape as honoJsxEscape,
  jsxTemplate as honoJsxTemplate,
} from "hono/jsx/jsx-runtime";
import {
  type BoundSignalReference,
  type HandlerReference,
  handlerReferenceAttributes,
  isBoundSignal,
  isSignalBinding,
  signalChild,
  type SignalProperty,
  signalPropertyAttribute,
  signalPropertyProps,
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
 * What each attribute `jsxAttr` rendered from a handler reference or a
 * signal property was given, so a signal property can merge its handlers with
 * those the same tag binds.
 */
const attributeSources = new WeakMap<object, [name: string, value: unknown]>();

function sourceOf(value: unknown): [string, unknown] | undefined {
  return value && typeof value === "object"
    ? attributeSources.get(value)
    : undefined;
}

/** Rendered attributes joined by spaces, as one value of the template. */
function joinAttributes(parts: unknown[]): ReturnType<typeof honoJsxTemplate> {
  const strings = ["", ...parts.slice(1).map(() => " "), ""];
  return honoJsxTemplate(
    Object.assign(strings, { raw: strings }) as TemplateStringsArray,
    ...parts,
  );
}

/**
 * An attribute as `jsxAttr` renders it, except that a boolean (a signal
 * property's initial value, such as `hidden`) is present when true and left
 * out when false, as `jsx` renders it, rather than `hidden="false"`, and
 * undefined (a bound attribute's) leaves it out.
 */
function initialAttribute(name: string, value: unknown): unknown {
  if (value === undefined) return honoJsxTemplate``;
  if (typeof value !== "boolean") return jsxAttr(name, value as never);
  return value ? honoJsxAttr(name, "") : honoJsxTemplate``;
}

/** Renders `entries` as one value, marked if one binds a lifecycle event. */
function renderAttributes(entries: [string, unknown][]): unknown {
  const joined = joinAttributes(
    entries.map(([name, part]) => initialAttribute(name, part)),
  );
  const event = entries.map(([name]) => lifecycleEvent(name)).find(Boolean);
  return event ? markLifecycleAttribute(joined, event) : joined;
}

/**
 * Expands the signals given as properties or attributes in a precompiled
 * template as `signalPropertyProps` does for `jsx`, once per element: each
 * attribute renders on its own, so the tag's `onConnect` and `onSignal` are rendered
 * again with the bindings' handlers first, each property's slot renders the
 * property and the attribute naming its signal, and the first such slot
 * renders the `onConnect` and `onSignal` the tag had none of.
 */
function bindSignalProperties(
  values: unknown[],
  slots: readonly ValueSlot[],
): void {
  /** The slots of each element's signal properties, by element index. */
  const elements = new Map<number, number[]>();
  values.forEach((value, index) => {
    const element = slots[index]?.element;
    if (element === undefined || !isSignalBinding(sourceOf(value)?.[0])) {
      return;
    }
    elements.set(element, [...elements.get(element) ?? [], index]);
  });
  for (const [element, bound] of elements) {
    /** The tag's other attributes `signalPropertyProps` merges, by name. */
    const merged = new Map<string, number>();
    values.forEach((other, at) => {
      const name = sourceOf(other)?.[0];
      if (
        slots[at]?.element === element &&
        /^on(connect|signal)$/i.test(name ?? "")
      ) merged.set(name!, at);
    });
    const properties = bound.map((at) => sourceOf(values[at])!);
    const props = signalPropertyProps(
      Object.fromEntries([
        ...properties,
        ...[...merged].map(([name, at]) => [name, sourceOf(values[at])![1]]),
      ]),
      slots[bound[0]].tag,
    );
    for (const [name, at] of merged) {
      values[at] = jsxAttr(name, props[name] as never);
      delete props[name];
    }
    const own = bound.map((_, i) => {
      const property = properties[i][0] as Parameters<
        typeof signalPropertyAttribute
      >[0];
      const entries = [property, signalPropertyAttribute(property)].map(
        (name): [string, unknown] => [name, props[name]],
      );
      for (const [name] of entries) delete props[name];
      return entries;
    });
    // A textarea's text sits between its tags, out of an attribute's reach.
    if ("children" in props) {
      if (props.children !== "") {
        throw new TypeError(
          `A precompiled <${
            slots[bound[0]].tag
          }> cannot render its signal's initial value as its text. Use signal.name.withInitial() to keep its own text as a placeholder, or add it to "jsxPrecompileSkipElements".`,
        );
      }
      delete props.children;
    }
    own[0].push(...Object.entries(props));
    bound.forEach((at, i) => values[at] = renderAttributes(own[i]));
  }
}

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
  bindSignalProperties(values, slots);
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

/** A precompiled child expression: a signal reference renders as live text. */
export const jsxEscape: typeof honoJsxEscape = (value) =>
  honoJsxEscape(signalChild(value) as typeof value);

export const jsxTemplate: typeof honoJsxTemplate = withTemplateRoots(
  honoJsxTemplate,
  inspectTemplate,
);

export const jsx: typeof honoJsx = (tag, props, key) => {
  // A component gets its children as given; where it places them in an
  // element (or fragment), a signal reference among them renders as live text.
  if (tag === Fragment && props && "children" in props) {
    props = { ...props, children: signalChild(props.children) };
  }
  if (typeof tag === "function") {
    return honoJsx(wrapComponent(tag as (props: never) => unknown), props, key);
  }
  if (props && "children" in props) {
    const children = signalChild(props.children);
    if (children !== props.children) props = { ...props, children };
  }
  if (!props) return markElementNode(honoJsx(tag, props, key));
  props = signalPropertyProps(props, tag);
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

/**
 * Classic-runtime factory for the package's own TSX, which compiles with
 * `"jsx": "react"` because JSR cannot resolve the package importing its own
 * `jsx-runtime` through an automatic `jsxImportSource`. Moves the children
 * and key into the automatic shape and delegates to `jsx`.
 */
export function h(
  tag: Parameters<typeof jsx>[0],
  props: Record<string, unknown> | null,
  ...children: unknown[]
): ReturnType<typeof jsx> {
  const { key, ...rest } = props ?? {};
  if (children.length) {
    rest.children = children.length === 1 ? children[0] : children;
  }
  return jsx(tag, rest, key as string | undefined);
}

/** Classic mode looks up the JSX types on the factory, so `h.JSX` is ours. */
export declare namespace h {
  export type { JSX };
}

export const jsxAttr = (
  name: string,
  value:
    | Parameters<typeof honoJsxAttr>[1]
    | HandlerReference<string, unknown>
    | readonly HandlerReference<string, unknown>[],
): ReturnType<typeof honoJsxAttr> => {
  if (isSignalBinding(name) && isBoundSignal(value)) {
    // Alone it is the initial value; `bindSignalProperties` makes it live.
    const rendered = honoJsxTemplate`${
      initialAttribute(name, signalPropertyProps({ [name]: value })[name])
    }`;
    attributeSources.set(rendered, [name, value]);
    return rendered;
  }
  const attributes = handlerReferenceAttributes(name, value);
  if (!attributes) {
    return honoJsxAttr(name, value as Parameters<typeof honoJsxAttr>[1]);
  }
  // The event attribute, its `tt-handler-*` and, for an instance's
  // references, `tt-link`.
  const [first, ...more] = Object.entries(attributes) as [string, string][];
  const rendered = !first ? honoJsxTemplate`` : more.reduce<
    ReturnType<typeof honoJsxAttr>
  >(
    (joined, attribute) =>
      honoJsxTemplate`${joined} ${honoJsxAttr(...attribute)}`,
    honoJsxAttr(...first),
  );
  if (typeof rendered === "object") {
    attributeSources.set(rendered, [name, value]);
  }
  if (!first) return rendered;
  const event = lifecycleEvent(name);
  return event ? markLifecycleAttribute(rendered, event) : rendered;
};

import type { JSX as HonoJSX } from "hono/jsx/jsx-runtime";
import type { IncomingDataEvent } from "./handlers/processIncomingData.ts";
import type { SortedEvent } from "./handlers/dragSortTools.ts";

// ============================================================================
// Event Handler Types with Descriptive Error Messages
// ============================================================================

/**
 * Event handler type for JSX attributes: a handler reference from
 * `tiny.imports()` (`fn.name`, `signal.name`), or a list of them.
 *
 * The handler's event parameter type is checked via natural contravariance:
 * a handler accepting `Event` is valid for any specific event (e.g., `onSubmit`),
 * while a handler accepting `MouseEvent` would be rejected for `onSubmit`.
 *
 * The `this` parameter remains broad so element-specific handlers can still be
 * passed through JSX without forcing every intrinsic prop to model its exact
 * receiver element type.
 */
type ClientEventHandler<E extends Event> =
  | HandlerReference<string, (event: E) => unknown>
  | readonly HandlerReference<string, (event: E) => unknown>[]
  | undefined;

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
  /** Dispatched by `dragSortTools` after a list item moves. */
  onSorted?: ClientEventHandler<SortedEvent>;

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

/** The tags that take a signal as each property, as `signalProperties` lists. */
type SignalPropertyTags = {
  [Property in SignalProperty]: Property extends "value" ? "input" | "textarea"
    : Property extends "checked" ? "input"
    : Property extends "selected" ? "option"
    : Property extends "disabled" ?
        | "button"
        | "fieldset"
        | "input"
        | "optgroup"
        | "option"
        | "select"
        | "textarea"
    : string;
};

/**
 * A signal from `tiny.imports()` as one of the element's `signalProperties`
 * (an input's `value`, any element's `hidden`) keeps it live.
 */
type SignalPropertyOverride<Tag extends keyof HonoJSX.IntrinsicElements> = {
  [
    Property in SignalProperty as Tag extends SignalPropertyTags[Property]
      ? Property
      : never
  ]?:
    | (Property extends keyof HonoJSX.IntrinsicElements[Tag]
      ? HonoJSX.IntrinsicElements[Tag][Property]
      : never)
    | BoundSignalReference;
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
      & ElementEventOverridesStrict
      & SignalPropertyOverride<K>
    >;
  };
}
