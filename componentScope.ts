/**
 * Component scope markers for @tinytools/hono-tools
 *
 * The JSX runtime wraps every function component so the element(s) it
 * returns carry a `data-tc` attribute. Component-scoped styles use that
 * attribute as the lower edge of their `@scope` donut, so a component's
 * styles reach through its own markup but stop at the root of any child
 * component.
 *
 * @module
 */

import { Fragment, isValidElement } from "hono/jsx";
import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type JSXNode = {
  tag: string | ((...args: never[]) => unknown);
  props: Record<string, unknown>;
  children: unknown[];
};

/** Attribute placed on the root element(s) of every rendered component. */
export const COMPONENT_ROOT_ATTRIBUTE = "data-tc";

const TRANSPARENT = Symbol.for("tinytools.transparentComponent");
const WRAPPED = Symbol.for("tinytools.wrappedComponent");
const ELEMENT = Symbol.for("tinytools.elementNode");
const TEMPLATE_ROOTS = Symbol.for("tinytools.templateRoots");

/**
 * @internal Set on a rendered element (a node, or a precompiled template with
 * that element at its top level) whose lifecycle handler only fires once an
 * `<upgrade-preceding>` proxy follows it; the value names the element and
 * the event. The JSX runtime sets it, `UpgradeCustomElement` clears it, and
 * placing a value still carrying it inside another element is an error.
 */
export const NEEDS_PROXY = Symbol.for("tinytools.needsLifecycleProxy");

/** @internal The element and lifecycle event waiting for a proxy. */
export type ProxyNeed = { tag: string; event: string };

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

const wrappedComponents = new WeakMap<AnyFunction, AnyFunction>();

/**
 * Opt a component out of component scoping. Its output is treated as part of
 * the caller's markup, so the caller's component-scoped styles keep reaching
 * into it. Used for framework wrappers such as partials and suspense.
 */
export function transparent<T extends AnyFunction>(component: T): T {
  (component as unknown as Record<symbol, boolean>)[TRANSPARENT] = true;
  return component;
}

/** @internal Flags a node created from an intrinsic (string) tag. */
export function markElementNode<T>(node: T): T {
  if (node && typeof node === "object") {
    (node as Record<symbol, boolean>)[ELEMENT] = true;
  }
  return node;
}

function isElementNode(node: JSXNode): boolean {
  return (node as unknown as Record<symbol, boolean>)[ELEMENT] === true ||
    (typeof node.tag === "string" && node.tag !== "");
}

function collectChildNodes(children: unknown, into: Set<unknown>): void {
  if (Array.isArray(children)) {
    for (const child of children) collectChildNodes(child, into);
  } else if (children && typeof children === "object") {
    into.add(children);
  }
}

function markRoots(
  result: unknown,
  name: string,
  passedChildren: Set<unknown>,
): unknown {
  // Content handed in by the caller (props.children) belongs to the caller.
  if (passedChildren.has(result)) return result;
  if (Array.isArray(result)) {
    return result.map((item) => markRoots(item, name, passedChildren));
  }
  if (result && typeof result === "object" && TEMPLATE_ROOTS in result) {
    return markTemplateRoots(result as TemplateResult, name);
  }
  if (!isValidElement(result)) return result;
  const node = result as unknown as JSXNode;

  if (node.tag === Fragment) {
    // Hono renders from node.children, so both copies must be updated.
    const copy = cloneNode(node, {
      ...node.props,
      children: markRoots(node.props.children, name, passedChildren),
    });
    copy.children = node.children.map((child) =>
      markRoots(child, name, passedChildren)
    );
    return copy;
  }

  // Another component's node (it marks its own root) or an opaque function.
  if (!isElementNode(node)) return result;
  if (COMPONENT_ROOT_ATTRIBUTE in node.props) return result;

  return cloneNode(node, {
    ...node.props,
    [COMPONENT_ROOT_ATTRIBUTE]: name,
  });
}

// ---------------------------------------------------------------------------
// Precompiled JSX (`"jsx": "precompile"`)
//
// Plain elements compile to `jsxTemplate(strings, ...values)`, which Hono
// renders to a string immediately. The static strings of a call site never
// change, so they are scanned once for top-level tags. A sentinel value is
// rendered right after each top-level tag name, then stripped, leaving the
// offsets on the result. A component wrapper that receives the template as
// its return value inserts `data-tc` at those offsets; any other template
// simply carries unused offsets.
// ---------------------------------------------------------------------------

type TemplateResult = HtmlEscapedString & {
  [TEMPLATE_ROOTS]: number[];
  [NEEDS_PROXY]?: ProxyNeed;
};

type TemplatePlan = {
  strings: string[];
  /** For each value slot: an original value index, or -1 for a sentinel. */
  slots: number[];
};

/**
 * @internal Where a value slot of a precompiled template sits. `depth` is
 * the number of open ancestors in the template: 0 for a top-level element's
 * attribute or a child beside the top-level content. An attribute slot also
 * names the open tag it sits in.
 */
export type ValueSlot = {
  depth: number;
  tag?: string;
  /** The index of the element among the template's open tags. */
  element?: number;
  /** The element's static `is` attribute, when it has one. */
  is?: string;
};

type TemplateAnalysis = {
  plan: TemplatePlan | null;
  slots: readonly ValueSlot[];
};

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Private-use characters plus a per-process nonce: cannot collide with markup.
const SENTINEL = `tc${crypto.randomUUID().slice(0, 8)}`;
const SENTINEL_VALUE = raw(SENTINEL);
const templateAnalyses = new WeakMap<readonly string[], TemplateAnalysis>();

/**
 * Scans the static strings once: the offsets just after each top-level tag
 * name, as [segment, offset] pairs, and for each value slot the open tag it
 * sits in, if any.
 */
function scanTemplate(strings: readonly string[]): {
  cuts: [number, number][];
  slots: ValueSlot[];
} {
  const cuts: [number, number][] = [];
  const slots: ValueSlot[] = [];
  /** The static text of each open tag, in order, for its `is` attribute. */
  const openTags: string[] = [];
  let depth = 0;
  let inTag = false;
  let tagName = "";
  let tagIsVoid = false;
  let quote = "";
  for (let segment = 0; segment < strings.length; segment++) {
    if (segment > 0) {
      slots.push(
        inTag && !quote
          ? { tag: tagName, depth, element: openTags.length - 1 }
          : { depth },
      );
    }
    const text = strings[segment];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inTag) {
        openTags[openTags.length - 1] += ch;
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ">") {
          inTag = false;
          if (!tagIsVoid && text[i - 1] !== "/") depth++;
        }
        i++;
        continue;
      }
      if (ch !== "<") {
        i++;
        continue;
      }
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      if (text[i + 1] === "/") {
        depth = Math.max(0, depth - 1);
        const end = text.indexOf(">", i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      const name = /^[a-zA-Z][\w:-]*/.exec(text.slice(i + 1))?.[0];
      if (!name) {
        i++;
        continue;
      }
      if (depth === 0) cuts.push([segment, i + 1 + name.length]);
      inTag = true;
      tagName = name;
      tagIsVoid = VOID_ELEMENTS.has(name.toLowerCase());
      openTags.push("");
      i += 1 + name.length;
    }
  }
  // An `is` written statically may sit before or after the slot in its tag.
  const isAttributes = openTags.map((text) => {
    const match = /\sis\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text);
    return match ? match[1] ?? match[2] : undefined;
  });
  return {
    cuts,
    slots: slots.map((slot) =>
      slot.element !== undefined && isAttributes[slot.element]
        ? { ...slot, is: isAttributes[slot.element] }
        : slot
    ),
  };
}

function analyseTemplate(strings: readonly string[]): TemplateAnalysis {
  const known = templateAnalyses.get(strings);
  if (known) return known;
  const { cuts, slots } = scanTemplate(strings);
  let plan: TemplatePlan | null = null;
  if (cuts.length > 0) {
    plan = { strings: [], slots: [] };
    let current = "";
    for (let segment = 0; segment < strings.length; segment++) {
      let start = 0;
      for (const [cutSegment, offset] of cuts) {
        if (cutSegment !== segment) continue;
        plan.strings.push(current + strings[segment].slice(start, offset));
        plan.slots.push(-1);
        current = "";
        start = offset;
      }
      current += strings[segment].slice(start);
      if (segment < strings.length - 1) {
        plan.strings.push(current);
        plan.slots.push(segment);
        current = "";
      }
    }
    plan.strings.push(current);
  }
  const analysis = { plan, slots };
  templateAnalyses.set(strings, analysis);
  return analysis;
}

function stripSentinels(rendered: HtmlEscapedString): TemplateResult {
  const text = String(rendered);
  const roots: number[] = [];
  let output = "";
  let from = 0;
  for (
    let at = text.indexOf(SENTINEL);
    at >= 0;
    at = text.indexOf(SENTINEL, from)
  ) {
    output += text.slice(from, at);
    roots.push(output.length);
    from = at + SENTINEL.length;
  }
  output += text.slice(from);
  const result = raw(output, rendered.callbacks) as TemplateResult;
  result[TEMPLATE_ROOTS] = roots;
  return result;
}

/**
 * @internal Wraps Hono's `jsxTemplate` so precompiled templates remember
 * where their top-level elements start. `inspect` sees each call's values
 * with the open tag each attribute value sits in, and the proxy need it
 * returns is recorded on the result (see `NEEDS_PROXY`).
 */
export function withTemplateRoots<
  T extends (strings: TemplateStringsArray, ...values: unknown[]) => unknown,
>(
  render: T,
  inspect?: (
    values: unknown[],
    slots: readonly ValueSlot[],
  ) => ProxyNeed | undefined,
): T {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const { plan, slots } = analyseTemplate(strings);
    const need = inspect?.(values, slots);
    if (!plan && !need) return render(strings, ...values);
    const rendered = (plan
      ? render(
        plan.strings as unknown as TemplateStringsArray,
        ...plan.slots.map((slot) => slot < 0 ? SENTINEL_VALUE : values[slot]),
      )
      : render(strings, ...values)) as
        | HtmlEscapedString
        | Promise<HtmlEscapedString>;
    const finish = (output: HtmlEscapedString): HtmlEscapedString => {
      const result = plan ? stripSentinels(output) : output;
      if (need && typeof result === "object") {
        (result as TemplateResult)[NEEDS_PROXY] = need;
      }
      return result;
    };
    return rendered instanceof Promise
      ? rendered.then(finish)
      : finish(rendered);
  }) as T;
}

/**
 * @internal The top-level tag names of a precompiled template (`"jsx":
 * "precompile"` renders elements to strings at once), or undefined for any
 * other value.
 */
export function templateRootTags(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || !(TEMPLATE_ROOTS in value)) {
    return undefined;
  }
  const text = String(value);
  return (value as TemplateResult)[TEMPLATE_ROOTS].map((offset) =>
    /<([a-zA-Z][\w:-]*)$/.exec(text.slice(0, offset))?.[1] ?? ""
  );
}

function markTemplateRoots(
  template: TemplateResult,
  name: string,
): HtmlEscapedString {
  const text = String(template);
  const attribute = ` ${COMPONENT_ROOT_ATTRIBUTE}="${
    name.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`)
  }"`;
  let output = "";
  let from = 0;
  for (const at of template[TEMPLATE_ROOTS]) {
    output += text.slice(from, at) + attribute;
    from = at;
  }
  // The new string carries no offsets, so outer components leave it alone.
  const result = raw(output + text.slice(from), template.callbacks) as
    & HtmlEscapedString
    & { [NEEDS_PROXY]?: ProxyNeed };
  if (template[NEEDS_PROXY]) result[NEEDS_PROXY] = template[NEEDS_PROXY];
  return result;
}

function cloneNode(node: JSXNode, props: JSXNode["props"]): JSXNode {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(node)),
    node,
  ) as JSXNode;
  copy.props = props;
  return copy;
}

function markResult(
  result: unknown,
  name: string,
  props: Record<string, unknown> | undefined,
): unknown {
  const passedChildren = new Set<unknown>();
  collectChildNodes(props?.children, passedChildren);
  return result instanceof Promise
    ? result.then((resolved) => markRoots(resolved, name, passedChildren))
    : markRoots(result, name, passedChildren);
}

/**
 * Explicitly mark JSX as a component root. The JSX runtime does this
 * automatically for `<Component />`; use it when a component is called as a
 * plain function (for example `await SiteChrome({ children })` in a layout).
 *
 * @example
 * ```tsx
 * return tiny.component(<section class={styled.card}>...</section>, "Card");
 * ```
 */
export function component<T>(jsx: T, name = ""): T {
  return markResult(jsx, name, undefined) as T;
}

/** @internal Returns a stable wrapper that marks the component's root. */
export function wrapComponent<T extends AnyFunction>(tag: T): T {
  if (
    tag === (Fragment as unknown) ||
    (tag as unknown as Record<symbol, boolean>)[TRANSPARENT] ||
    (tag as unknown as Record<symbol, boolean>)[WRAPPED]
  ) {
    return tag;
  }
  let wrapped = wrappedComponents.get(tag);
  if (!wrapped) {
    const name = tag.name;
    wrapped = function (this: unknown, props: Record<string, unknown>) {
      // Transparency may be declared after first render (e.g. in a module
      // that assigns it later), so re-check at call time.
      if ((tag as unknown as Record<symbol, boolean>)[TRANSPARENT]) {
        return tag.call(this, props);
      }
      return markResult(tag.call(this, props), name, props);
    };
    Object.defineProperty(wrapped, "name", { value: name });
    (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
    wrappedComponents.set(tag, wrapped);
  }
  return wrapped as T;
}
