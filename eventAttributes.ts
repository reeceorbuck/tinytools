import type { JSX } from "./jsx-runtime.ts";
import type { InstanceSignal } from "./signals.ts";

/**
 * The inline attribute body every TinyTools event binding emits. It is shared by
 * all events and handlers so one CSP hash authorises every binding.
 */
export const eventHandlerBody = "tiny.runHandler(this,event)";

/**
 * Events the runtime hands to `tiny.runHandler` itself (lifecycle and signal
 * events, and those forwarded from `navigation` or `window`). Browsers only
 * run inline attributes for their own events, so these render just their
 * `tt-handler-*` attribute.
 */
const RUNTIME_EVENTS = new Set([
  "connect",
  "disconnect",
  "parsed",
  "signal",
  "sorted",
  "navigate",
  "currententrychange",
  "incomingdata",
]);

/** A handler reference as `tt-handler-*` attributes carry it: `<bundle>.<name>`. */
const handlerReferencePattern = /^\w+\.[$\w]+$/;

declare const handlerReferenceBrand: unique symbol;

export type HandlerReference<TName extends string, TFunction> = {
  readonly [handlerReferenceBrand]: {
    readonly name: TName;
    readonly signature: TFunction;
  };
};

/**
 * Type for a component prop that receives an imported handler reference, such as
 * `fn.handleClick`, which the component forwards to an element's event attribute.
 *
 * @example
 * ```tsx
 * function Card(props: { onConnect?: HandlerProp<(this: HTMLElement) => void> }) {
 *   return <article onConnect={props.onConnect}>...</article>;
 * }
 * ```
 */
export type HandlerProp<TFunction> = HandlerReference<string, TFunction>;

/**
 * Type for a component prop that receives a signal reference from
 * `tiny.imports()`, such as `signal.query`, which the component binds as an
 * element property or attribute or subscribes with `onConnect`.
 *
 * @example
 * ```tsx
 * function Search(props: { query: SignalProp<string> }) {
 *   return <input value={props.query} />;
 * }
 * ```
 */
export type SignalProp<Value = unknown> =
  & HandlerReference<string, unknown>
  & {
    readonly initial: Value;
    /** See `RenderableSignal.withInitial`. */
    withInitial(initial?: Value): SignalProp<Value>;
  };

export type HandlerReferences<TFunctions> = {
  readonly [Name in keyof TFunctions]:
    & HandlerReference<
      Name & string,
      TFunctions[Name]
    >
    & TFunctions[Name];
};

/**
 * Signals are typed as the signal itself so handlers read `signal.name.value`
 * directly. The handler reference brand keeps them usable as JSX event
 * handlers, where they are resolved as references like `fn.*`.
 */
export type SignalReferences<TSignals> = {
  readonly [Name in keyof TSignals]:
    & HandlerReference<Name & string, TSignals[Name]>
    & SignalOrigin<Pick<TSignals, Name>>
    // deno-lint-ignore no-explicit-any
    & (TSignals[Name] extends (...args: any[]) => infer Signal
      ? Signal & RenderableSignal<Signal>
      : never);
};

declare const signalOriginBrand: unique symbol;

/**
 * Type-only: the signal's entry in the collection it came from. A `Pick`
 * keeps the link to where the signal is declared, so types rebuilt from a
 * list of references (`instanced(render, [signal.press])`) still go to
 * its definition in the editor.
 */
export type SignalOrigin<TEntry> = {
  readonly [signalOriginBrand]?: TEntry;
};

/**
 * Rendering helpers on a signal reference from `tiny.imports()`. Placed as a
 * JSX child (`<p>Total: {signal.total}</p>`), the reference itself renders as
 * live text: an inline `<signal-text>` holding the initial value, subscribed
 * to the signal so each change replaces its text.
 */
export interface RenderableSignal<Signal> {
  /**
   * The value the signal starts with, as `evaluateUsingInitialValues()`
   * reports it (a per-instance signal's is a fresh instance's), for
   * initial markup such as an input's `value`.
   */
  readonly initial: SignalInitial<Signal>;
  /**
   * This signal with `initial` rendered in place of the value it starts
   * with, wherever it is bound or placed, for values the server cannot
   * render (a seeded per-instance signal's) or a placeholder. Without one,
   * the binding renders no initial value and leaves the element's own markup
   * as it is, so a textarea's children are its placeholder:
   * `<textarea value={signal.message.withInitial()}>Loading…</textarea>`.
   * The signal replaces it on its next change, or at once with
   * `fn.fireSelfSignal` in `onConnect`.
   */
  withInitial(initial?: SignalInitial<Signal>): this;
}

/** The value type of a signal, as `RenderableSignal.initial` gives it. */
type SignalInitial<Signal> = Signal extends // deno-lint-ignore no-explicit-any
InstanceSignal<infer Value, any, any> ? Value
  : Signal extends { readonly value: infer Value } ? Value
  : never;

/**
 * A signal reference from `tiny.imports()`, given as an element property such
 * as an input's `value` or an option's `selected`.
 */
export type BoundSignalReference =
  & HandlerReference<string, unknown>
  & { readonly initial: unknown };

/**
 * The element properties a signal reference can be given as, each with the
 * tags that take it (any tag when omitted). `signalBindingTools.setBound` writes
 * the signal into every one an element binds.
 */
export const signalProperties: {
  readonly [
    Property in
      | "value"
      | "checked"
      | "selected"
      | "disabled"
      | "hidden"
  ]: { readonly tags?: readonly string[] };
} = {
  // A select's `value` attribute is not what it shows. A textarea's is not
  // either, so a textarea renders no initial value (see signalPropertyProps).
  value: { tags: ["input", "textarea"] },
  checked: { tags: ["input"] },
  selected: { tags: ["option"] },
  disabled: {
    tags: [
      "button",
      "fieldset",
      "input",
      "optgroup",
      "option",
      "select",
      "textarea",
    ],
  },
  hidden: {},
};

export type SignalProperty = keyof typeof signalProperties;

/**
 * A `data-*` or `aria-*` attribute, which any element takes a signal as: the
 * signal's value is written as the attribute's text (`false` as `"false"`,
 * which `aria-expanded` relies on), and `null` or `undefined` removes it.
 */
export type SignalAttribute = `data-${string}` | `aria-${string}`;

/** A property or attribute a signal reference can be given as. */
export type SignalBinding = SignalProperty | SignalAttribute;

/** Whether `name` is a property a signal reference can be given as. */
export function isSignalProperty(name: unknown): name is SignalProperty {
  return typeof name === "string" && Object.hasOwn(signalProperties, name);
}

/** Whether `name` is a `data-*` or `aria-*` attribute. */
export function isSignalAttribute(name: unknown): name is SignalAttribute {
  return typeof name === "string" && /^(data|aria)-./.test(name);
}

/** Whether `name` is a property or attribute a signal reference can be given as. */
export function isSignalBinding(name: unknown): name is SignalBinding {
  return isSignalProperty(name) || isSignalAttribute(name);
}

/** What `tiny.imports()` gives signal references to implement `RenderableSignal`. */
export type SignalRendering = {
  initial(name: string): unknown;
  /** Live text for `reference`, starting from `initial`. */
  text(reference: object, initial: unknown): JSX.Element;
  /** The handler an element given a signal as a property runs (`setBound`). */
  setter(): object;
};

/** The attribute naming the signal `binding` follows (`tt-value-signal`). */
export function signalPropertyAttribute(binding: SignalBinding): string {
  return `tt-${binding}-signal`;
}

/** What a signal reference given as an element property or attribute binds. */
type SignalPropertyBinding = {
  /**
   * The initial value, written as the setter writes it: undefined leaves an
   * attribute out.
   */
  initial: string | boolean | undefined;
  /**
   * Whether the reference renders no initial value (`withInitial()`), leaving
   * the element's own markup in place.
   */
  omitted: boolean;
  /** `<bundle>.<name>`, which the setter checks each signal event against. */
  signal: string;
  /** The signal reference, subscribed by `onConnect`. */
  onConnect: object;
  /** The setter, run by `onSignal`. */
  onSignal: object;
};

const referenceDetails = new WeakMap<
  object,
  {
    name: string;
    resolved: string;
    /** The `tt-link` of the component instance a reference from `instance.signal` acts on. */
    links?: string;
  }
>();

/** Each signal reference's live text, rendered when it is placed as a child. */
const signalTexts = new WeakMap<object, () => JSX.Element>();

/**
 * What the JSX runtime renders for a child: a signal reference becomes its
 * live text, other values are returned as they are. Arrays are searched, since a
 * child expression may hold several.
 */
export function signalChild(value: unknown): unknown {
  if (Array.isArray(value)) {
    const children = value.map(signalChild);
    return children.some((child, index) => child !== value[index])
      ? children
      : value;
  }
  if (typeof value !== "object" || value === null) return value;
  return signalTexts.get(value)?.() ?? value;
}

/** Each signal reference's binding as an element property or attribute. */
const signalBindings = new WeakMap<
  object,
  (binding: SignalBinding) => SignalPropertyBinding
>();

/** Whether `value` is a signal reference, which an element property binds as live. */
export function isBoundSignal(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    signalBindings.has(value);
}

/** Whether JSX `children` holds anything to render (whitespace counts). */
function hasChildren(children: unknown): boolean {
  if (Array.isArray(children)) return children.some(hasChildren);
  return children !== undefined && children !== null && children !== false &&
    children !== "";
}

/**
 * An element's props with signal references given as properties or
 * attributes (`<input value={signal.query} />`, `<div
 * data-status={signal.status}>`) expanded to what keeps them live: each
 * initial value, `onConnect` subscribing each signal and `onSignal` running
 * each setter once, all placed first among the handlers the element already
 * binds. A `tt-<name>-signal` attribute names each binding's signal, so its
 * setter ignores the other signals the element subscribes to. Other props
 * are returned as they are.
 */
export function signalPropertyProps(
  props: Record<string, unknown>,
  tag?: string,
): Record<string, unknown> {
  const bound = Object.keys(props).filter((name): name is SignalBinding =>
    isSignalBinding(name) && isBoundSignal(props[name])
  );
  if (bound.length === 0) return props;
  const misplaced = tag === undefined ? undefined : bound.find((
    binding,
  ): binding is SignalProperty =>
    isSignalProperty(binding) &&
    signalProperties[binding].tags?.includes(tag.toLowerCase()) === false
  );
  if (misplaced) {
    const { tags = [] } = signalProperties[misplaced];
    const owners = tags.map((owner) => `<${owner}>`);
    const list = owners.length > 1
      ? `${owners.slice(0, -1).join(", ")} or ${owners.at(-1)}`
      : owners[0];
    throw new TypeError(
      `<${tag}> cannot take a signal as its ${misplaced}; only ${list} can. Bind onConnect={signal.name} and an onSignal handler of your own instead.`,
    );
  }
  const expanded: Record<string, unknown> = { ...props };
  /** Each signal's reference, by `<bundle>.<name>`. */
  const connects = new Map<string, object>();
  /** The setter, which writes every binding of the element. */
  let setter: object | undefined;
  for (const name of bound) {
    const binding = signalBindings.get(props[name] as object)!(name);
    if (binding.omitted) {
      // The element keeps its own markup (a textarea's children).
      delete expanded[name];
    } else if (name === "value" && tag?.toLowerCase() === "textarea") {
      // A textarea shows its children, not a `value` attribute.
      if (hasChildren(props.children)) {
        throw new TypeError(
          "A <textarea> given a signal as its value takes no children: the signal's initial value is its text. Use signal.name.withInitial() to keep its children as a placeholder instead.",
        );
      }
      delete expanded.value;
      expanded.children = binding.initial;
    } else {
      expanded[name] = binding.initial;
    }
    expanded[signalPropertyAttribute(name)] = binding.signal;
    // A signal bound twice is subscribed once, and the setter writes
    // every binding, so it runs once.
    if (!connects.has(binding.signal)) {
      connects.set(binding.signal, binding.onConnect);
    }
    setter ??= binding.onSignal;
  }
  for (
    const [attribute, references] of [
      ["onConnect", [...connects.values()]],
      ["onSignal", [setter!]],
    ] as const
  ) {
    // An event attribute matches whatever its case (`onconnect` too).
    const name = Object.keys(expanded).find((key) =>
      key.toLowerCase() === attribute.toLowerCase()
    ) ?? attribute;
    const existing = expanded[name];
    expanded[name] = [
      ...references,
      ...(existing === undefined || existing === null
        ? []
        : Array.isArray(existing)
        ? existing
        : [existing]),
    ];
  }
  return expanded;
}

export function handlerReferenceAttributes(
  attributeName: string,
  value: unknown,
): Record<string, string> | undefined {
  const eventName = /^on([a-z]+)$/i.exec(attributeName)?.[1].toLowerCase();
  const multiple = Array.isArray(value) && !!eventName;
  const values = multiple ? value : [value];
  const references = values.map((reference) =>
    typeof reference === "object" && reference !== null
      ? referenceDetails.get(reference)
      : undefined
  );
  if (!multiple && !references[0]) return undefined;
  if (!eventName || eventName === "mount" || eventName === "unmount") {
    throw new TypeError(
      `Handler references cannot be used for ${attributeName}`,
    );
  }
  const handlerNames = references.map((details) => {
    if (!details) {
      throw new TypeError(
        "Expected an imported handler reference in event handler array",
      );
    }
    if (!handlerReferencePattern.test(details.resolved)) {
      throw new TypeError(`Invalid handler reference: ${details.name}`);
    }
    return details.resolved;
  });
  if (!handlerNames.length) return {};
  // An instance's references link the element into that instance, as its
  // own parts are, so it resolves wherever (and whether) they are rendered.
  const instances = new Set(
    references.flatMap((details) => details?.links ?? []),
  );
  if (instances.size > 1) {
    throw new TypeError(
      `${attributeName} binds signals of several instances (${
        [...instances].join(", ")
      }); an element can act on one instance only.`,
    );
  }
  return {
    ...(RUNTIME_EVENTS.has(eventName) ? {} : {
      [`on${eventName}`]: eventHandlerBody,
    }),
    [`tt-handler-${eventName}`]: handlerNames.join(" "),
    ...(instances.size ? { "tt-link": [...instances][0] } : {}),
  };
}

export function createHandlerReferences<TFunctions>(
  resolveHandler: (name: string) => unknown,
): HandlerReferences<TFunctions> {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      const resolved = resolveHandler(name);
      if (typeof resolved !== "string") return undefined;
      const reference = Object.freeze({});
      referenceDetails.set(reference, { name, resolved });
      return reference;
    },
  }) as HandlerReferences<TFunctions>;
}

export function createSignalReferences<TSignals>(
  resolveHandler: (name: string) => unknown,
  rendering?: SignalRendering,
  /** Binds every reference to the component instance with this `tt-link`. */
  links?: string,
): SignalReferences<TSignals> {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      const resolved = resolveHandler(name);
      if (typeof resolved !== "string") return undefined;
      const renderingFor = (member: string) => {
        if (!rendering) {
          throw new Error(
            `signal.${name} ${member} is only available on signals from tiny.imports().`,
          );
        }
        return rendering;
      };
      const unavailable = () => {
        throw new Error(
          `Signal '${name}' is only a handler reference while rendering. Read signal values in client handlers.`,
        );
      };
      /**
       * A reference rendering `initialOf()` as the value it starts with, or,
       * when `omitted`, no initial value at all.
       */
      const createReference = (
        initialOf: () => unknown,
        omitted = false,
      ): object => {
        const reference: object = Object.freeze(Object.defineProperties({}, {
          value: { get: unavailable, set: unavailable },
          subscribe: { get: unavailable },
          unsubscribe: { get: unavailable },
          initial: { get: initialOf },
          withInitial: {
            value: (initial?: unknown) =>
              createReference(() => initial, initial === undefined),
          },
          // A template literal (`${signal.x}`) would stringify the reference.
          [Symbol.toPrimitive]: {
            value: () => {
              throw new Error(
                `Signal '${name}' was turned into a string. Place it as a JSX child ({signal.${name}}) for live text, or use signal.${name}.initial for its initial value.`,
              );
            },
          },
        }));
        signalTexts.set(
          reference,
          () =>
            renderingFor("as a JSX child").text(
              reference,
              omitted ? "" : initialOf(),
            ),
        );
        signalBindings.set(reference, (binding) => {
          const rendering = renderingFor(`as ${binding}`);
          const initial = initialOf();
          const signal = resolved;
          if (!handlerReferencePattern.test(signal)) {
            throw new TypeError(`Invalid handler reference: ${name}`);
          }
          return {
            // Written as the setter writes it.
            initial: isSignalAttribute(binding)
              ? initial?.toString()
              : binding === "value"
              ? initial?.toString() ?? ""
              : Boolean(initial),
            omitted,
            signal,
            onConnect: reference,
            onSignal: rendering.setter(),
          };
        });
        referenceDetails.set(reference, { name, resolved, links });
        return reference;
      };
      return createReference(() =>
        renderingFor("used as .initial").initial(name)
      );
    },
  }) as SignalReferences<TSignals>;
}
