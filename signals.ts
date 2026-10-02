export type SignalValue = string | number | boolean | null;

export interface ReadonlySignal<Value = SignalValue> {
  readonly value: Value;
  /**
   * Optional name, used by handlers such as `setCssProperty`. Set in the
   * factory, or automatically from the `name` (or `data-bind-name`) of an
   * input whose input/change event writes the signal.
   */
  name?: string;
  subscribe(target: EventTarget): void;
}

export interface Signal<Value = SignalValue> extends ReadonlySignal<Value> {
  value: Value;
}

export interface SignalTools {
  Signal: new <Value extends SignalValue = SignalValue>(
    initialValue?: Value,
  ) => Signal<Value>;
  Computed: new <Value>(
    compute: () => Value,
    dependencies: readonly ReadonlySignal<unknown>[],
  ) => ReadonlySignal<Value>;
}

export type SignalDefinitions = Record<string, ReadonlySignal<unknown>>;

export type SignalAccessors<Definitions extends SignalDefinitions> = {
  [Name in keyof Definitions]: (
    this: unknown,
    event?: Event | null,
  ) => Definitions[Name];
};

export function signalClasses(runtime = true): SignalTools {
  class SignalInstance<Value = SignalValue> extends EventTarget
    implements Signal<Value> {
    #name?: string;
    #value: Value;
    #subscriptions = new WeakMap<EventTarget, EventListener>();

    constructor(initialValue: Value = null as Value) {
      super();
      this.#value = initialValue;
      this.#name = undefined;
    }

    get name(): string | undefined {
      return this.#name;
    }

    set name(name: string | undefined) {
      this.#name = name;
    }

    get value(): Value {
      if (!runtime) {
        throw new Error("Signal values are only available in client handlers.");
      }
      return this.#value;
    }

    set value(value: Value) {
      if (!runtime) {
        throw new Error("Signal values are only available in client handlers.");
      }
      if (Object.is(this.#value, value)) return;
      this.#value = value;
      this.dispatchEvent(this.createEvent());
    }

    createEvent(): Event {
      return Object.assign(new Event("signal"), {
        signal: this,
      });
    }

    subscribe(target: EventTarget): void {
      if (!runtime) {
        throw new Error("Signals can only be subscribed in client handlers.");
      }
      if (this.#subscriptions.has(target)) return;
      const element = target as EventTarget & {
        abortController?: AbortController;
      };
      const abortSignal = element.abortController?.signal;
      if (abortSignal?.aborted) return;
      const listener = (event: Event) => {
        if (
          typeof HTMLElement !== "undefined" && target instanceof HTMLElement
        ) {
          tiny.runHandler(target, event);
        } else {
          target.dispatchEvent(this.createEvent());
        }
      };
      this.#subscriptions.set(target, listener);
      this.addEventListener("signal", listener, { signal: abortSignal });
      abortSignal?.addEventListener(
        "abort",
        () => this.#subscriptions.delete(target),
        { once: true },
      );
    }

    handleEvent(target: unknown, event?: Event | null): this {
      if (event?.type === "input" || event?.type === "change") {
        this.value = (event.target as HTMLInputElement).value as Value;
        const elName = (event.target as HTMLInputElement).dataset.bindName ||
          (event.target as HTMLInputElement).name;
        if (elName) this.name = elName;
      } else if (event?.type === "load" && target instanceof EventTarget) {
        this.subscribe(target);
      }
      return this;
    }
  }

  class ComputedInstance<Value> extends SignalInstance<Value>
    implements ReadonlySignal<Value> {
    constructor(
      compute: () => Value,
      dependencies: readonly ReadonlySignal<unknown>[],
    ) {
      super(runtime ? compute() : undefined as Value);
      if (runtime) {
        const target = new EventTarget();
        target.addEventListener("signal", () => {
          super.value = compute();
        });
        for (const dependency of new Set(dependencies)) {
          dependency.subscribe(target);
        }
      }
    }

    override get value(): Value {
      return super.value;
    }

    override set value(_value: Value) {
      throw new TypeError("Computed signals are read-only.");
    }
  }

  return { Signal: SignalInstance, Computed: ComputedInstance };
}

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };
