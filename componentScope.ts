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
