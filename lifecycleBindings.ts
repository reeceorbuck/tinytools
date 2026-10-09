/**
 * The rules the JSX runtime applies when an element binds a lifecycle
 * handler (`onConnect` or `onDisconnect`), and the check that catches
 * `onLoad` where nothing fires it.
 *
 * A custom tag (one with a hyphen), or a plain tag with a hyphenated `is`
 * attribute, is recorded as a lifecycle tag, so the page declares it and the
 * inline head runtime upgrades it; no wrapper is needed. A plain tag with no
 * `is` at all gets one (`<input is="tt-input">`, see `automaticLifecycleIs`),
 * so it becomes a customized built-in the same way. A plain tag whose `is`
 * has no hyphen only receives `connect` and `disconnect` from an
 * `<upgrade-preceding>` proxy, which `UpgradeCustomElement` renders after it,
 * so the runtime marks the element as needing one and throws when the
 * element is placed inside another element while still marked: that is
 * where a forgotten wrapper shows up. `onLoad` belongs to the elements the browser fires `load` on
 * (`<body>`, `<img>`, `<link>` and the like); on anything else it throws,
 * since a lifecycle element runs `onConnect` instead.
 *
 * @module
 */

import { Fragment } from "hono/jsx";
import { recordLifecycleTag } from "./clientTools.ts";
import { NEEDS_PROXY, type ProxyNeed } from "./componentScope.ts";
import { lifecycleTagDeclaration } from "./lifecycleElement.ts";

/** @internal Set by `jsxAttr` on a lifecycle event attribute; the value is the event. */
const LIFECYCLE_ATTRIBUTE = Symbol.for("tinytools.lifecycleAttribute");

/** The events a lifecycle element runs through `tiny.runHandler`. */
const LIFECYCLE_EVENTS = new Set(["connect", "disconnect"]);

/** Plain tags on which the browser fires `load` itself. */
const NATIVE_LOAD_TAGS = new Set([
  "body",
  "embed",
  "iframe",
  "img",
  "link",
  "object",
  "script",
  "style",
  "track",
]);

type Marked = { [NEEDS_PROXY]?: ProxyNeed };

function attributeName(event: string): string {
  return `on${event[0].toUpperCase()}${event.slice(1)}`;
}

/** The lifecycle event named by an `on*` attribute, or `load`, which is checked too. */
export function lifecycleEvent(attribute: string): string | undefined {
  const event = /^on([a-z]+)$/i.exec(attribute)?.[1].toLowerCase();
  return event && (LIFECYCLE_EVENTS.has(event) || event === "load")
    ? event
    : undefined;
}

/**
 * The `is` the JSX runtime adds to a plain tag that binds `event` with no
 * `is` of its own, making it a customized built-in (`<input is="tt-input">`),
 * or undefined when the element needs none or already has one.
 */
export function automaticLifecycleIs(
  tag: string,
  event: string,
  is?: unknown,
): string | undefined {
  if (is !== undefined && is !== null) return undefined;
  if (!LIFECYCLE_EVENTS.has(event) || tag.includes("-")) return undefined;
  return `tt-${tag.toLowerCase()}`;
}

/**
 * Applies the binding rules for `event` on the intrinsic `tag`, with the
 * element's `is` attribute when it has one: records a custom tag or a
 * customized built-in, accepts a `load` the browser fires itself, throws
 * for a `load` nothing fires, and returns whether the element needs a proxy.
 */
export function lifecycleHandlerNeedsProxy(
  tag: string,
  event: string,
  is?: unknown,
): boolean {
  const name = tag.toLowerCase();
  const builtin = typeof is === "string" && is.includes("-")
    ? is.toLowerCase()
    : undefined;
  const custom = name.includes("-") || builtin !== undefined;
  if (event === "load") {
    if (NATIVE_LOAD_TAGS.has(name)) return false;
    if (custom) {
      throw new TypeError(
        `<${tag}> never fires load: a lifecycle element runs onConnect (and onDisconnect) instead, so bind that.`,
      );
    }
    // Only a trigger rendered after it (a loading `<link>`) fires `load`
    // on a plain element; the code rendering one claims the mark.
    return true;
  }
  if (custom) {
    recordLifecycleTag(builtin ? lifecycleTagDeclaration(builtin, name) : name);
    return false;
  }
  return true;
}

/** The error for an element placed without the proxy its handler needs. */
export function unproxiedLifecycleError({ tag, event }: ProxyNeed): TypeError {
  if (event === "load") {
    return new TypeError(
      `<${tag}> binds onLoad but nothing fires load on it. Bind onConnect instead; the element then upgrades by itself.`,
    );
  }
  return new TypeError(
    `<${tag}> binds ${
      attributeName(event)
    } but nothing fires it. Give its is="..." attribute a hyphen (a customized built-in), remove the attribute so the runtime adds one, give it a custom tag with a hyphen, or wrap it in <UpgradeCustomElement>, which renders an <upgrade-preceding> proxy after it.`,
  );
}

/** @internal Marks an attribute value rendered by `jsxAttr` as binding `event`. */
export function markLifecycleAttribute<T>(value: T, event: string): T {
  if (value && typeof value === "object") {
    (value as Record<symbol, string>)[LIFECYCLE_ATTRIBUTE] = event;
  }
  return value;
}

/** @internal The lifecycle event an attribute value from `jsxAttr` binds, if any. */
export function lifecycleAttributeEvent(value: unknown): string | undefined {
  return value && typeof value === "object"
    ? (value as Record<symbol, string | undefined>)[LIFECYCLE_ATTRIBUTE]
    : undefined;
}

/** @internal Marks a rendered element as waiting for a proxy. */
export function markNeedsProxy<T>(value: T, need: ProxyNeed): T {
  if (value && typeof value === "object") (value as Marked)[NEEDS_PROXY] = need;
  return value;
}

/** The elements in `value` that carry a proxy mark: it, its items, or those of a fragment. */
function* markedElements(value: unknown): Generator<Marked> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* markedElements(item);
    return;
  }
  if (NEEDS_PROXY in value) {
    yield value as Marked;
    return;
  }
  const node = value as {
    tag?: unknown;
    children?: unknown;
    props?: { children?: unknown };
  };
  if (node.tag === Fragment) {
    yield* markedElements(node.children ?? node.props?.children);
  }
}

/** @internal The first element in `value` still waiting for a proxy, if any. */
export function findUnproxied(value: unknown): ProxyNeed | undefined {
  for (const element of markedElements(value)) {
    if (element[NEEDS_PROXY]) return element[NEEDS_PROXY];
  }
}

/**
 * Clears the proxy marks in `value` (an element, a list of them, or a
 * fragment): the caller renders the proxy, or a trigger that fires the
 * handler, right after it. `UpgradeCustomElement` does this for its children.
 */
export function claimLifecycleProxy<T>(value: T): T {
  for (const element of markedElements(value)) delete element[NEEDS_PROXY];
  return value;
}
