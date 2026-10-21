import type { ActivatedClientFunction, JSX } from "./jsx-runtime.ts";
import type { InstanceSignal } from "./signals.ts";
import { tryGetContext } from "hono/context-storage";

/** Context variable recording whether the CSP-friendly reference transform is active. */
export const CSP_ENABLED_KEY = "tinyToolsCspEnabled";

/**
 * The inline attribute body every TinyTools event binding emits. It is shared by
 * all events and handlers so one CSP hash authorises every binding.
 */
export const eventHandlerBody = "tiny.runHandler(this,event)";

/** Matches `handlers.<bundle>.<name>.call(this, event)`, capturing `<bundle>.<name>`. */
const handlerReferencePattern =
  /^handlers\.(\w+\.[$\w]+)\.call\(this, event\)$/;

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
    // deno-lint-ignore no-explicit-any
    & (TSignals[Name] extends (...args: any[]) => infer Signal
      ? Signal & RenderableSignal<Signal>
      : never);
} & {
  /**
   * Every signal as seen from `element`: per-instance signals resolve to the
   * instance enclosing it, collection-wide signals are returned as they are.
   * Client handlers only.
   */
  filterByInstance(element: Element): InstanceScopedSignals<TSignals>;
};

/** What `signal.filterByInstance(element)` returns. */
export type InstanceScopedSignals<TSignals> = {
  readonly [Name in keyof TSignals]: TSignals[Name] extends
    // deno-lint-ignore no-explicit-any
    (...args: any[]) => infer Signal
    // deno-lint-ignore no-explicit-any
    ? Signal extends InstanceSignal<any, infer Instance, any> ? Instance
    : Signal
    : never;
};

/**
 * Rendering helpers on a signal reference from `tiny.imports()`. Placed as a
 * JSX child (`<p>Total: {signal.total}</p>`), the reference itself renders as
 * live text: an inline `<signal-text>` holding the initial value, subscribed
 * to the signal so each change replaces its text.
 */
export type RenderableSignal<Signal> = {
  /**
   * The value the signal starts with, as `evaluateUsingInitialValues()`
   * reports it (a per-instance signal's is a fresh instance's), for
   * initial markup such as an input's `value`.
   */
  readonly initial: Signal extends // deno-lint-ignore no-explicit-any
  InstanceSignal<infer Value, any, any> ? Value
    : Signal extends { readonly value: infer Value } ? Value
    : never;
};

/**
 * A signal reference from `tiny.imports()`, given as an element property such
 * as an input's `value` or an option's `selected`.
 */
export type BoundSignalReference =
  & HandlerReference<string, unknown>
  & { readonly initial: unknown };

/**
 * The element properties a signal reference can be given as, each with the
 * tags that take it (any tag when omitted) and the `signalTools` handler that
 * writes the signal into it.
 */
export const signalProperties: {
  readonly [
    Property in
      | "value"
      | "checked"
      | "selected"
      | "disabled"
      | "hidden"
  ]: {
    readonly tags?: readonly string[];
    readonly setter: `set${Capitalize<Property>}`;
  };
} = {
  // A textarea's or select's `value` attribute is not what it shows.
  value: { tags: ["input"], setter: "setValue" },
  checked: { tags: ["input"], setter: "setChecked" },
  selected: { tags: ["option"], setter: "setSelected" },
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
    setter: "setDisabled",
  },
  hidden: { setter: "setHidden" },
};

export type SignalProperty = keyof typeof signalProperties;

/** Whether `name` is a property a signal reference can be given as. */
export function isSignalProperty(name: unknown): name is SignalProperty {
  return typeof name === "string" && Object.hasOwn(signalProperties, name);
}

/** What `tiny.imports()` gives signal references to implement `RenderableSignal`. */
export type SignalRendering = {
  initial(name: string): unknown;
  text(reference: object, name: string): JSX.Element;
  /** The handler an element given a signal as `property` runs. */
  setter(property: SignalProperty): object;
};

/** The attribute naming the signal `property` follows (`tt-value-signal`). */
export function signalPropertyAttribute(property: SignalProperty): string {
  return `tt-${property}-signal`;
}

/** What a signal reference given as an element property binds. */
type SignalPropertyBinding = {
  /** The initial value, written as the property's setter writes it. */
  initial: string | boolean;
  /** `<bundle>.<name>`, which the setter checks each signal event against. */
  signal: string;
  /** The signal reference, subscribed by `onConnect`. */
  onConnect: object;
  /** The property's setter, run by `onSignal`. */
  onSignal: object;
};

const referenceDetails = new WeakMap<
  object,
  { name: string; resolved: string }
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

/** Each signal reference's binding as an element property. */
const signalBindings = new WeakMap<
  object,
  (property: SignalProperty) => SignalPropertyBinding
>();

/** Whether `value` is a signal reference, which an element property binds as live. */
export function isBoundSignal(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    signalBindings.has(value);
}

/**
 * An element's props with signal references given as properties (`<input
 * value={signal.query} />`, `<option selected={signal.isDental}>`) expanded
 * to what keeps them live: each initial value, `onConnect` subscribing each
 * signal and `onSignal` running each property's setter, all placed first
 * among the handlers the element already binds. A `tt-<property>-signal`
 * attribute names each property's signal, so its setter ignores the other
 * signals the element subscribes to. Other props are returned as they are.
 */
export function signalPropertyProps(
  props: Record<string, unknown>,
  tag?: string,
): Record<string, unknown> {
  const bound = (Object.keys(signalProperties) as SignalProperty[])
    .filter((property) => isBoundSignal(props[property]));
  if (bound.length === 0) return props;
  const misplaced = tag === undefined
    ? undefined
    : bound.find((property) =>
      signalProperties[property].tags?.includes(tag.toLowerCase()) === false
    );
  if (misplaced) {
    const { tags = [], setter } = signalProperties[misplaced];
    const owners = tags.map((owner) => `<${owner}>`);
    const list = owners.length > 1
      ? `${owners.slice(0, -1).join(", ")} or ${owners.at(-1)}`
      : owners[0];
    throw new TypeError(
      `<${tag}> cannot take a signal as its ${misplaced}; only ${list} can. Bind onConnect={signal.name} and onSignal={fn.${setter}} instead.`,
    );
  }
  const expanded: Record<string, unknown> = { ...props };
  /** Each signal's reference, by `<bundle>.<name>`. */
  const connects = new Map<string, object>();
  const setters: object[] = [];
  for (const property of bound) {
    const binding = signalBindings.get(props[property] as object)!(property);
    expanded[property] = binding.initial;
    expanded[signalPropertyAttribute(property)] = binding.signal;
    // A signal bound to two properties is subscribed once.
    if (!connects.has(binding.signal)) {
      connects.set(binding.signal, binding.onConnect);
    }
    setters.push(binding.onSignal);
  }
  for (
    const [attribute, references] of [
      ["onConnect", [...connects.values()]],
      ["onSignal", setters],
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
    const match = handlerReferencePattern.exec(details.resolved);
    if (!match) {
      throw new TypeError(`Invalid handler reference: ${details.name}`);
    }
    return match[1];
  });
  if (!handlerNames.length) return {};
  if (
    tryGetContext<{ Variables: { [CSP_ENABLED_KEY]: boolean } }>()?.get(
      CSP_ENABLED_KEY,
    ) === false
  ) {
    return {
      [attributeName]: references.map((details) => details!.resolved).join(
        "; ",
      ),
    };
  }
  return {
    [`on${eventName}`]: eventHandlerBody,
    [`tt-handler-${eventName}`]: handlerNames.join(" "),
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
): SignalReferences<TSignals> {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "filterByInstance") {
        return () => {
          throw new Error(
            "signal.filterByInstance() resolves instances in client handlers; while rendering, bind signals as signal.name.",
          );
        };
      }
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
      const reference: object = Object.freeze(Object.defineProperties({}, {
        value: { get: unavailable, set: unavailable },
        subscribe: { get: unavailable },
        unsubscribe: { get: unavailable },
        initial: { get: () => renderingFor("used as .initial").initial(name) },
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
        () => renderingFor("as a JSX child").text(reference, name),
      );
      signalBindings.set(reference, (property) => {
        const rendering = renderingFor(`as ${property}`);
        const initial = rendering.initial(name);
        const signal = handlerReferencePattern.exec(resolved)?.[1];
        if (!signal) throw new TypeError(`Invalid handler reference: ${name}`);
        return {
          // Written as the property's setter writes it.
          initial: property !== "value"
            ? Boolean(initial)
            : initial?.toString() ?? "",
          signal,
          onConnect: reference,
          onSignal: rendering.setter(property),
        };
      });
      referenceDetails.set(reference, { name, resolved });
      return reference;
    },
  }) as SignalReferences<TSignals>;
}

type HandlerName<TFunctions, TEvent extends Event> =
  & {
    [Name in keyof TFunctions]: TFunctions[Name] extends
      (this: ThisParameterType<TFunctions[Name]>, event: TEvent) => unknown
      ? Name
      : never;
  }[keyof TFunctions]
  & string;

type EventBindings<TFunctions> = {
  [Name in keyof GlobalEventHandlersEventMap]?:
    | HandlerName<TFunctions, GlobalEventHandlersEventMap[Name]>
    | HandlerReferences<TFunctions>[
      HandlerName<TFunctions, GlobalEventHandlersEventMap[Name]>
    ];
};

type EventAttributes<TBindings> =
  & {
    [Name in keyof TBindings & string as `on${Name}`]: ActivatedClientFunction;
  }
  & {
    [Name in keyof TBindings & string as `tt-handler-${Name}`]: string;
  };

export type Events<TFunctions> = <
  const TBindings extends EventBindings<TFunctions>,
>(
  bindings:
    & TBindings
    & Record<
      Exclude<keyof TBindings, keyof GlobalEventHandlersEventMap>,
      never
    >,
) => EventAttributes<TBindings>;

export function createEvents<TFunctions>(
  resolveHandler: (name: string) => unknown,
): Events<TFunctions> {
  return ((bindings: Record<string, unknown>) => {
    const attributes: Record<string, string> = {};
    for (const [eventName, binding] of Object.entries(bindings)) {
      if (!/^[a-z]+$/.test(eventName)) {
        throw new TypeError(`Invalid event name: ${eventName}`);
      }
      const details = typeof binding === "object" && binding !== null
        ? referenceDetails.get(binding)
        : undefined;
      const handlerName = typeof binding === "string" ? binding : details?.name;
      if (handlerName === undefined) {
        throw new TypeError("Expected an imported handler reference or name");
      }
      const resolved = resolveHandler(handlerName);
      if (details && resolved !== details.resolved) {
        throw new TypeError(`Event handler is not imported: ${handlerName}`);
      }
      const match = typeof resolved === "string"
        ? handlerReferencePattern.exec(resolved)
        : null;
      if (!match) {
        throw new TypeError(`Event handler is not imported: ${handlerName}`);
      }
      attributes[`on${eventName}`] = eventHandlerBody;
      attributes[`tt-handler-${eventName}`] = match[1];
    }
    return attributes;
  }) as unknown as Events<TFunctions>;
}
