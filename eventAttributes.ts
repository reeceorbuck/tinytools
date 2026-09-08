import type { ActivatedClientFunction } from "./jsx-runtime.ts";

// export const eventHandlerBody =
//   'return globalThis.handlers[this.getAttribute("tt-handler-"+event.type)].call(this,event)';

export const eventHandlerBody = "handlers.fn.call(this,event)";

declare const handlerReferenceBrand: unique symbol;

export type HandlerReference<TName extends string, TFunction> = {
  readonly [handlerReferenceBrand]: {
    readonly name: TName;
    readonly signature: TFunction;
  };
};

export type HandlerReferences<TFunctions> = {
  readonly [Name in keyof TFunctions]: HandlerReference<
    Name & string,
    TFunctions[Name]
  >;
};

const referenceDetails = new WeakMap<
  object,
  { name: string; resolved: string }
>();

export function handlerReferenceAttributes(
  attributeName: string,
  value: unknown,
): Record<string, string> | undefined {
  const details = typeof value === "object" && value !== null
    ? referenceDetails.get(value)
    : undefined;
  if (!details) return undefined;
  const eventName = /^on([a-z]+)$/i.exec(attributeName)?.[1].toLowerCase();
  if (!eventName || eventName === "mount" || eventName === "unmount") {
    throw new TypeError(
      `Handler references cannot be used for ${attributeName}`,
    );
  }
  const match = /^handlers\.(\w+)\.call\(this, event\)$/.exec(details.resolved);
  if (!match) throw new TypeError(`Invalid handler reference: ${details.name}`);
  return {
    [`on${eventName}`]: eventHandlerBody,
    [`tt-handler-${eventName}`]: match[1],
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
        ? /^handlers\.(\w+)\.call\(this, event\)$/.exec(resolved)
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
