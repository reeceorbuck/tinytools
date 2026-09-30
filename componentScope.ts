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

type TemplateResult = HtmlEscapedString & { [TEMPLATE_ROOTS]: number[] };

type TemplatePlan = {
  strings: string[];
  /** For each value slot: an original value index, or -1 for a sentinel. */
  slots: number[];
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
const templatePlans = new WeakMap<readonly string[], TemplatePlan | null>();

/** Offsets just after each top-level tag name, as [segment, offset] pairs. */
function findTopLevelTags(strings: readonly string[]): [number, number][] {
  const cuts: [number, number][] = [];
  let depth = 0;
  let inTag = false;
  let tagIsVoid = false;
  let quote = "";
  for (let segment = 0; segment < strings.length; segment++) {
    const text = strings[segment];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inTag) {
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
      const tagName = /^[a-zA-Z][\w:-]*/.exec(text.slice(i + 1))?.[0];
      if (!tagName) {
        i++;
        continue;
      }
      if (depth === 0) cuts.push([segment, i + 1 + tagName.length]);
      inTag = true;
      tagIsVoid = VOID_ELEMENTS.has(tagName.toLowerCase());
      i += 1 + tagName.length;
    }
  }
  return cuts;
}

function planTemplate(strings: readonly string[]): TemplatePlan | null {
  if (templatePlans.has(strings)) return templatePlans.get(strings)!;
  const cuts = findTopLevelTags(strings);
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
  templatePlans.set(strings, plan);
  return plan;
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
 * where their top-level elements start.
 */
export function withTemplateRoots<
  T extends (strings: TemplateStringsArray, ...values: unknown[]) => unknown,
>(render: T): T {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const plan = planTemplate(strings);
    if (!plan) return render(strings, ...values);
    const rendered = render(
      plan.strings as unknown as TemplateStringsArray,
      ...plan.slots.map((slot) => slot < 0 ? SENTINEL_VALUE : values[slot]),
    ) as HtmlEscapedString | Promise<HtmlEscapedString>;
    return rendered instanceof Promise
      ? rendered.then(stripSentinels)
      : stripSentinels(rendered);
  }) as T;
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
  return raw(output + text.slice(from), template.callbacks);
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
