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
  readonly initial: Signal extends
    // deno-lint-ignore no-explicit-any
    InstanceSignal<infer Value, any, any> ? Value
    : Signal extends { readonly value: infer Value } ? Value
    : never;
};

/** A signal reference from `tiny.imports()`, given as an element's `value`. */
export type SignalValueReference =
  & HandlerReference<string, unknown>
  & { readonly initial: unknown };

/** What `tiny.imports()` gives signal references to implement `RenderableSignal`. */
export type SignalRendering = {
  initial(name: string): unknown;
  text(reference: object, name: string): JSX.Element;
  /** `fn.setValue`, which an element given a signal as `value` runs. */
  setValue(): object;
};

/** The attribute naming the signal an element's `value` follows. */
export const SIGNAL_VALUE_ATTRIBUTE = "tt-value-signal";

/** What a signal reference given as an element's `value` binds. */
type SignalValueBinding = {
  /** The initial value, written as `setValue` writes it. */
  value: string;
  /** `<bundle>.<name>`, which `setValue` checks each signal event against. */
  signal: string;
  /** The signal reference, subscribed by `onConnect`. */
  onConnect: object;
  /** `fn.setValue`, run by `onSignal`. */
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

/** Each signal reference's binding as an element's `value`. */
const signalValues = new WeakMap<object, () => SignalValueBinding>();

/** Whether `value` is a signal reference, which `value` binds as live. */
export function isSignalValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && signalValues.has(value);
}

/**
 * An input's props with a signal reference given as `value` (`<input
 * value={signal.query} />`) expanded to what keeps it live: the initial
 * value, `onConnect` subscribing the signal and `onSignal` running
 * `setValue`, each placed first among the handlers the element already binds.
 * `tt-value-signal` names the signal, so `setValue` ignores the other signals
 * the element subscribes to. Other props are returned as they are.
 */
export function signalValueProps(
  props: Record<string, unknown>,
  tag?: string,
): Record<string, unknown> {
  const value = props.value;
  if (!isSignalValue(value)) return props;
  // A textarea's or select's `value` attribute is not what it shows.
  if (tag !== undefined && tag.toLowerCase() !== "input") {
    throw new TypeError(
      `Only an <input> takes a signal as its value, not <${tag}>. Bind onConnect={signal.name} and onSignal={fn.setValue} instead.`,
    );
  }
  const binding = signalValues.get(value as object)!();
  const expanded: Record<string, unknown> = {
    ...props,
    value: binding.value,
    [SIGNAL_VALUE_ATTRIBUTE]: binding.signal,
  };
  for (
    const [attribute, reference] of [
      ["onConnect", binding.onConnect],
      ["onSignal", binding.onSignal],
    ] as const
  ) {
    // An event attribute matches whatever its case (`onconnect` too).
    const name = Object.keys(expanded).find((key) =>
      key.toLowerCase() === attribute.toLowerCase()
    ) ?? attribute;
    const bound = expanded[name];
    expanded[name] = [
      reference,
      ...(bound === undefined || bound === null
        ? []
        : Array.isArray(bound)
        ? bound
        : [bound]),
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
      signalValues.set(reference, () => {
        const rendering = renderingFor("as a value");
        const initial = rendering.initial(name);
        const signal = handlerReferencePattern.exec(resolved)?.[1];
        if (!signal) throw new TypeError(`Invalid handler reference: ${name}`);
        return {
          // Written as setValue writes it.
          value: initial?.toString() ?? "",
          signal,
          onConnect: reference,
          onSignal: rendering.setValue(),
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
