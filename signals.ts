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

/** Type-only marker telling writable signals apart from computed ones. */
declare const writableSignal: unique symbol;

export interface Signal<Value = SignalValue> extends ReadonlySignal<Value> {
  value: Value;
  readonly [writableSignal]?: true;
}

/** Type-only marker recording which named `perInstance` a signal belongs to. */
declare const instanceLevel: unique symbol;

/**
 * A signal defined inside `perInstance`: every instance root (an element
 * whose `tt-instance` attribute holds the collection's `instanceKey`) gets
 * its own copy.
 * Bound in JSX (`onChange={signal.name}`, `onLoad={signal.name}`) it resolves
 * to the instance enclosing the element, so markup needs nothing extra.
 * `Level` is the name given to `perInstance(name, ...)`, or `never` for an
 * unnamed one.
 */
export interface InstanceSignal<
  Value = SignalValue,
  Instance extends ReadonlySignal<Value> = Signal<Value>,
  Level extends string = never,
> {
  name?: string;
  /** The signal of the instance enclosing `element`. */
  for(element: Element): Instance;
  /**
   * Every instance's value in document order. It updates when any instance
   * changes and when instance roots are added or removed, so a `Computed`
   * depending on it reflects the net result of all instances.
   */
  readonly all: ReadonlySignal<Value[]>;
  /** Subscribes `target` to the instance enclosing it. */
  subscribe(target: Element): void;
  readonly [instanceLevel]?: Level;
}

/**
 * The per-instance handles `perInstance` returns, one per signal it defines.
 * Nested per-instance signals keep their own level.
 */
export type InstanceSignals<Definitions, Level extends string = never> = {
  // deno-lint-ignore no-explicit-any
  [Name in keyof Definitions]: Definitions[Name] extends
    InstanceSignal<any, any, any> ? Definitions[Name]
    : Definitions[Name] extends Signal<infer Value>
      ? InstanceSignal<Value, Definitions[Name], Level>
    : Definitions[Name] extends ReadonlySignal<infer Value>
      ? InstanceSignal<Value, Definitions[Name], Level>
    : never;
};

/** What a `perInstance` callback may return: signals, or nested per-instance signals. */
export type InstanceDefinitions = Record<
  string,
  | ReadonlySignal<unknown>
  | InstanceSignal<unknown, ReadonlySignal<unknown>, string>
>;

/**
 * The `perInstance` names used by a collection's signals: what
 * `instanceKeyFor` accepts. A named group counts once at least one of its
 * signals is returned from the factory.
 */
export type InstanceLevels<Definitions> = {
  [Name in keyof Definitions]: Definitions[Name] extends
    { readonly [instanceLevel]?: infer Level } ? Exclude<Level, undefined>
    : never;
}[keyof Definitions];

export interface SignalTools {
  Signal: {
    new <Value extends SignalValue>(initialValue: Value): Signal<Value>;
    /**
     * Without an initial value a signal starts as `null`, so that is only
     * allowed when the value type includes `null`.
     */
    new <Value extends SignalValue = SignalValue>(
      ...args: null extends Value ? [] : [initialValue: Value]
    ): Signal<Value>;
  };
  Computed: new <Value>(
    compute: () => Value,
    dependencies: readonly ReadonlySignal<unknown>[],
  ) => ReadonlySignal<Value>;
  perInstance: {
    /**
     * Defines signals that every instance root gets its own copy of. `define`
     * runs once per instance, so `Signal`s and `Computed`s inside it see only
     * that instance's values. Spread the result into the collection to export
     * the signals by name. Roots carry `tt-instance={collection.instanceKey}`.
     */
    <Definitions extends InstanceDefinitions>(
      define: () => Definitions,
    ): InstanceSignals<Definitions>;
    /**
     * A named group, required when nested inside another `perInstance`: one
     * group per parent instance, whose `.all` covers only the roots inside
     * that parent. Roots carry `tt-instance={collection.instanceKeyFor(name)}`.
     */
    <const Level extends string, Definitions extends InstanceDefinitions>(
      name: Level,
      define: () => Definitions,
    ): InstanceSignals<Definitions, Level>;
  };
}

export type SignalDefinitions = Record<
  string,
  | ReadonlySignal<unknown>
  | InstanceSignal<unknown, ReadonlySignal<unknown>, string>
>;

export type SignalAccessors<Definitions extends SignalDefinitions> = {
  [Name in keyof Definitions]: (
    this: unknown,
    event?: Event | null,
  ) => Definitions[Name];
};

/** The values `evaluateUsingInitialValues` accepts: any of the collection's writable signals. */
export type SignalInputs<Definitions extends SignalDefinitions> = {
  [
    Name in keyof Definitions as typeof writableSignal extends
      keyof Definitions[Name] ? Name : never
  ]?: Definitions[Name] extends ReadonlySignal<infer Value> ? Value : never;
};

/** The value of every signal in a collection, as `evaluateUsingInitialValues` returns them. */
export type SignalValues<Definitions extends SignalDefinitions> = {
  [Name in keyof Definitions]: Definitions[Name] extends
    ReadonlySignal<infer Value> ? Value
    // deno-lint-ignore no-explicit-any
    : Definitions[Name] extends InstanceSignal<infer Value, any, any> ? Value
    : never;
};

/**
 * The signal classes for one collection. `instanceKey` identifies that
 * collection's instance roots: elements whose space-separated `tt-instance`
 * attribute includes it. Everything lives inside this function because it
 * alone is sent to the browser.
 */
export function signalClasses(
  runtime = true,
  instanceKey?: string,
): SignalTools {
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
    #compute: () => Value;

    constructor(
      compute: () => Value,
      dependencies: readonly ReadonlySignal<unknown>[],
    ) {
      super(runtime ? compute() : undefined as Value);
      this.#compute = compute;
      if (runtime) {
        const target = new EventTarget();
        target.addEventListener("signal", () => this.refresh());
        for (const dependency of new Set(dependencies)) {
          dependency.subscribe(target);
        }
      }
    }

    /** Recomputes the value, notifying subscribers if it changed. */
    refresh(): void {
      if (runtime) super.value = this.#compute();
    }

    override get value(): Value {
      return super.value;
    }

    override set value(_value: Value) {
      throw new TypeError("Computed signals are read-only.");
    }
  }

  type Graph = Record<string, SignalInstance<unknown> | InstanceSignalHandle>;

  /**
   * Where a `perInstance` call is running: `undefined` at the top of the
   * factory (instances span the document), `null` while building a detached
   * template (inert), or the instance root of the enclosing `perInstance`
   * (nested instances live inside it).
   */
  let currentScope: Element | null | undefined;

  function withScope<Result>(
    scope: Element | null,
    run: () => Result,
  ): Result {
    const previous = currentScope;
    currentScope = scope;
    try {
      return run();
    } finally {
      currentScope = previous;
    }
  }

  /**
   * One `perInstance` call: a copy of its graph per instance root, created
   * the first time something inside the root touches one of its signals (or
   * when an `.all` aggregate finds the root). A nested call makes one group
   * per instance of its parent, holding only the roots inside that instance.
   */
  class InstanceGroup {
    #define: () => Graph;
    #key: string;
    #selector: string;
    #scope: Element | null | undefined;
    #instances = new Map<Element, Graph>();
    #aggregates = new Map<string, ComputedInstance<unknown[]>>();
    #observer?: MutationObserver;
    /** A detached copy listing the signal names and server-side values. */
    readonly template: Graph;

    constructor(define: () => Graph, key: string) {
      this.#define = define;
      this.#key = key;
      this.#selector = `[tt-instance~="${key}"]`;
      this.#scope = currentScope;
      this.template = withScope(null, define);
    }

    instanceFor(element: Element): Graph {
      const root = typeof element?.closest === "function"
        ? element.closest(this.#selector)
        : null;
      if (!root || (this.#scope && !this.#scope.contains(root))) {
        throw new Error(
          `Per-instance signals must be used inside an instance root: an element with tt-instance="${this.#key}" (the collection's \`instanceKey\`, or \`instanceKeyFor(name)\` for a named perInstance).`,
        );
      }
      let graph = this.#instances.get(root);
      if (!graph) {
        graph = this.#create(root);
        this.#refreshAggregates();
      }
      return graph;
    }

    #create(root: Element): Graph {
      const graph = withScope(root, this.#define);
      this.#instances.set(root, graph);
      for (const [name, signal] of Object.entries(graph)) {
        // Nested per-instance signals are aggregated by their own group.
        if (!(signal instanceof SignalInstance)) continue;
        const target = new EventTarget();
        target.addEventListener(
          "signal",
          () => this.#aggregates.get(name)?.refresh(),
        );
        signal.subscribe(target);
      }
      return graph;
    }

    aggregate(name: string): ComputedInstance<unknown[]> {
      if (this.template[name] instanceof InstanceSignalHandle) {
        throw new TypeError(
          "`.all` is not available for a nested per-instance signal here: read it inside the enclosing perInstance, where it covers that instance.",
        );
      }
      let aggregate = this.#aggregates.get(name);
      if (!aggregate) {
        this.#observe();
        aggregate = new ComputedInstance(() => this.#values(name), []);
        this.#aggregates.set(name, aggregate);
      }
      return aggregate;
    }

    #values(name: string): unknown[] {
      return [...this.#instances.keys()]
        .filter((root) => root.isConnected)
        .sort((a, b) =>
          a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */
            ? -1
            : 1
        )
        .map((root) =>
          (this.#instances.get(root)![name] as SignalInstance<unknown>).value
        );
    }

    /** Matches instances to the roots in scope; true if they changed. */
    #sync(): boolean {
      let changed = false;
      const scope = this.#scope ?? document;
      for (const root of scope.querySelectorAll(this.#selector)) {
        if (!this.#instances.has(root)) {
          this.#create(root);
          changed = true;
        }
      }
      for (const root of [...this.#instances.keys()]) {
        if (!root.isConnected) {
          this.#instances.delete(root);
          changed = true;
        }
      }
      return changed;
    }

    /** Keeps the instances in step with the DOM once aggregates exist. */
    #observe(): void {
      if (
        !runtime || this.#observer || this.#scope === null ||
        typeof document === "undefined" ||
        typeof MutationObserver === "undefined"
      ) return;
      this.#sync();
      this.#observer = new MutationObserver(() => {
        if (this.#sync()) this.#refreshAggregates();
      });
      this.#observer.observe(this.#scope ?? document, {
        childList: true,
        subtree: true,
      });
    }

    #refreshAggregates(): void {
      for (const aggregate of this.#aggregates.values()) aggregate.refresh();
    }
  }

  class InstanceSignalHandle<Value = unknown>
    implements InstanceSignal<Value, SignalInstance<Value>> {
    #group: InstanceGroup;
    #name: string;

    constructor(group: InstanceGroup, name: string) {
      this.#group = group;
      this.#name = name;
    }

    get name(): string | undefined {
      return this.#group.template[this.#name].name;
    }

    for(element: Element): SignalInstance<Value> {
      if (!runtime) {
        throw new Error("Signal values are only available in client handlers.");
      }
      const signal = this.#group.instanceFor(element)[this.#name];
      // A nested signal resolves its own, inner instance next.
      return signal instanceof InstanceSignalHandle
        ? signal.for(element) as SignalInstance<Value>
        : signal as SignalInstance<Value>;
    }

    get all(): ReadonlySignal<Value[]> {
      return this.#group.aggregate(this.#name) as ReadonlySignal<Value[]>;
    }

    /** The value of a fresh instance, as `evaluateUsingInitialValues` reports. */
    get initialValue(): Value {
      const signal = this.#group.template[this.#name];
      return (signal instanceof InstanceSignalHandle
        ? signal.initialValue
        : signal.value) as Value;
    }

    get value(): never {
      throw new Error(
        "Per-instance signals have a value per instance: read `.for(element).value`, or `.all.value` for every instance.",
      );
    }

    subscribe(target: Element): void {
      this.for(target).subscribe(target);
    }

    /**
     * As a handler, acts on the instance enclosing the element. Read from a
     * handler (no event) it returns itself so `.for()` and `.all` are reachable.
     */
    handleEvent(target: unknown, event?: Event | null): unknown {
      if (!event) return this;
      return this.for(target as Element).handleEvent(target, event);
    }
  }

  function perInstance(
    ...args: [define: () => Graph] | [name: string, define: () => Graph]
  ): Record<string, InstanceSignalHandle> {
    const [name, define] = args.length === 2 ? args : [undefined, args[0]];
    if (currentScope !== undefined && !name) {
      throw new TypeError(
        'A nested perInstance needs a name, e.g. perInstance("layer", () => ...), so its roots can be told apart from its parent\'s.',
      );
    }
    const group = new InstanceGroup(
      define,
      name ? `${instanceKey}-${name}` : `${instanceKey}`,
    );
    for (const signal of Object.values(group.template)) {
      if (
        !(signal instanceof SignalInstance) &&
        !(signal instanceof InstanceSignalHandle)
      ) {
        throw new TypeError(
          "perInstance must synchronously return an object of Signal, Computed or nested perInstance signals.",
        );
      }
    }
    return Object.fromEntries(
      Object.keys(group.template).map((
        signalName,
      ) => [signalName, new InstanceSignalHandle(group, signalName)]),
    );
  }

  return Object.assign(
    {
      Signal: SignalInstance,
      Computed: ComputedInstance,
      perInstance: perInstance as unknown as SignalTools["perInstance"],
    },
    // Not part of SignalTools: lets the server validate a factory's result.
    { InstanceSignal: InstanceSignalHandle },
  );
}

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };
