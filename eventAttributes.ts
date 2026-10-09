import type { ActivatedClientFunction } from "./jsx-runtime.ts";
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
    & (TSignals[Name] extends (...args: any[]) => infer Signal ? Signal
      : never);
};

const referenceDetails = new WeakMap<
  object,
  { name: string; resolved: string }
>();

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
): SignalReferences<TSignals> {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      const resolved = resolveHandler(name);
      if (typeof resolved !== "string") return undefined;
      const unavailable = () => {
        throw new Error(
          `Signal '${name}' is only a handler reference while rendering. Read signal values in client handlers.`,
        );
      };
      const reference = Object.freeze(Object.defineProperties({}, {
        value: { get: unavailable, set: unavailable },
        subscribe: { get: unavailable },
        unsubscribe: { get: unavailable },
      }));
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
