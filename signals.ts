/**
 * What a signal may hold. Besides plain values, a signal can carry an element
 * (or a list of them) so the elements of a page reach each other through the
 * signal network instead of id or selector lookups: an element publishes
 * itself from a handler (`signal.target.value = this`) and a subscriber reads
 * it. Elements exist only in the browser, so such a signal starts as `null`,
 * which is also what `evaluateUsingInitialValues` reports for it on the
 * server. A held element outlives its removal from the document: when the
 * holder is an upgraded custom element, clear the signal when its
 * `abortController` aborts.
 */
export type SignalValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | Element
  | readonly Element[];

export interface ReadonlySignal<Value = SignalValue> {
  readonly value: Value;
  /**
   * Optional name, used by handlers such as `setCssProperty`. Set in the
   * factory, or automatically from the `name` (or `data-bind-name`) of an
   * input whose input/change event writes the signal.
   */
  name?: string;
  subscribe(target: EventTarget): void;
  /** Ends a subscription made with `subscribe`. */
  unsubscribe(target: EventTarget): void;
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
 * Bound in JSX (`onChange={signal.name}`, `onConnect={signal.name}`,
 * `onClick={signal.name}`) it resolves to the instance enclosing the
 * element, so markup needs nothing extra.
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
   * changes, when an instance is first resolved (something inside its root
   * runs an `onConnect` or `onChange` reference) and when a root's
   * `abortController` aborts, so a `Computed` depending on it reflects the
   * net result of all instances.
   */
  readonly all: ReadonlySignal<Value[]>;
  /**
   * The value of a fresh instance, as the server renders it: the fallback
   * for a computed read of `.all` while no instance has resolved yet.
   */
  readonly initialValue: Value;
  /** Subscribes `target` to the instance enclosing it. */
  subscribe(target: Element): void;
  /** Ends `target`'s subscription to the instance enclosing it. */
  unsubscribe(target: Element): void;
  readonly [instanceLevel]?: Level;
}

// deno-lint-ignore no-explicit-any
type AnyInstanceSignal = InstanceSignal<any, any, any>;

/**
 * The per-instance handles `perInstance` returns, one per signal it defines.
 * Nested per-instance signals keep their own level.
 */
export type InstanceSignals<Definitions, Level extends string = never> = {
  [Name in keyof Definitions]: Definitions[Name] extends AnyInstanceSignal
    ? Definitions[Name]
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
  /**
   * A read-only signal recomputed whenever a signal its callback read
   * changes. Dependencies are tracked on every run, so reads behind
   * conditions count only while taken. `dependencies` may list extra signals
   * to follow (for example ones read only inside an untracked helper).
   */
  Computed: new <Value>(
    compute: () => Value,
    dependencies?: readonly ReadonlySignal<unknown>[],
  ) => ReadonlySignal<Value>;
  /**
   * One writable signal per entry of `initialValues`, under the same key and
   * typed from its value, so an object of defaults (usually from `constants`)
   * becomes a set of signals in one call. Spread the result into the
   * collection, or keep it and read `signals.name.value`.
   */
  signalsFrom<Values extends Record<string, SignalValue>>(
    initialValues: Values,
  ): { [Key in keyof Values]: Signal<Values[Key]> };
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

/**
 * A value `tiny.Signals` can embed in its browser bundle as a constant:
 * anything that survives a JSON round trip unchanged. `undefined`, functions,
 * dates, maps and sets are excluded because the server would see the original
 * while the browser sees the JSON copy.
 */
export type SignalConstant =
  | string
  | number
  | boolean
  | null
  | readonly SignalConstant[]
  | { readonly [key: string]: SignalConstant };

/**
 * Module-scope values a Signals factory may reference, keyed by the binding
 * name the factory uses for each one.
 */
export type SignalConstants = { readonly [name: string]: SignalConstant };

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
  /** Signals read while a computed callback runs, so it can follow them. */
  let tracking: Set<SignalInstance<unknown>> | null = null;

  function track<Value>(
    compute: () => Value,
  ): { value: Value; reads: Set<SignalInstance<unknown>> } {
    const previous = tracking;
    const reads = new Set<SignalInstance<unknown>>();
    tracking = reads;
    try {
      return { value: compute(), reads };
    } finally {
      tracking = previous;
    }
  }

  function untracked<Value>(read: () => Value): Value {
    const previous = tracking;
    tracking = null;
    try {
      return read();
    } finally {
      tracking = previous;
    }
  }

  /** Equal values do not notify; arrays compare by their items. */
  function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, index) => Object.is(item, b[index]));
  }

  /** The parts of a form control the runtime reads. */
  type Control = {
    type?: string;
    name?: string;
    value: string;
    checked?: boolean;
    multiple?: boolean;
    selectedOptions?: ArrayLike<{ value: string }>;
    dataset?: { bindName?: string };
  };

  /**
   * A control's value in the shape of the signal's current value: checkboxes
   * write `checked` to a boolean signal and otherwise the checked values of
   * their group, a multiple select its selected values, and a numeric signal
   * reads a number.
   */
  function readControl(
    control: Control,
    current: unknown,
    group: () => Control[],
  ): unknown {
    if (control.type === "checkbox") {
      if (typeof current === "boolean") return !!control.checked;
      return group().filter((input) => input.checked).map((input) =>
        input.value
      );
    }
    if (control.multiple && control.selectedOptions) {
      return Array.from(control.selectedOptions, (option) => option.value);
    }
    if (typeof current === "number") {
      return control.value === "" ? NaN : Number(control.value);
    }
    return control.value;
  }

  /** The other inputs of a checkbox group: those sharing its form and name. */
  function namedGroup(control: Control): Control[] {
    const form = (control as { form?: HTMLFormElement }).form;
    const named = control.name ? form?.elements.namedItem(control.name) : null;
    if (
      typeof RadioNodeList !== "undefined" && named instanceof RadioNodeList
    ) {
      return Array.from(named) as unknown as Control[];
    }
    return [control];
  }

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
      tracking?.add(this as SignalInstance<unknown>);
      return this.#value;
    }

    set value(value: Value) {
      if (!runtime) {
        throw new Error("Signal values are only available in client handlers.");
      }
      if (sameValue(this.#value, value)) return;
      this.#value = value;
      this.dispatchEvent(this.createEvent());
    }

    /** `initial` marks the event delivered when a target subscribes on load. */
    createEvent(initial = false): Event {
      return Object.assign(new Event("signal"), {
        signal: this,
        initial,
      });
    }

    /** Returns whether a new subscription was made. */
    subscribe(target: EventTarget): boolean {
      if (!runtime) {
        throw new Error("Signals can only be subscribed in client handlers.");
      }
      if (this.#subscriptions.has(target)) return false;
      const element = target as EventTarget & {
        abortController?: AbortController;
      };
      const abortSignal = element.abortController?.signal;
      if (abortSignal?.aborted) return false;
      const listener = (event: Event) => {
        if (
          typeof HTMLElement !== "undefined" && target instanceof HTMLElement
        ) {
          tiny.runHandler(target, event);
        } else {
          target.dispatchEvent(
            this.createEvent((event as { initial?: boolean }).initial),
          );
        }
      };
      this.#subscriptions.set(target, listener);
      this.addEventListener("signal", listener, { signal: abortSignal });
      abortSignal?.addEventListener(
        "abort",
        () => this.#subscriptions.delete(target),
        { once: true },
      );
      return true;
    }

    /** Sends the current value to a subscribed target as an initial event. */
    deliver(target: EventTarget): void {
      this.#subscriptions.get(target)?.(this.createEvent(true));
    }

    unsubscribe(target: EventTarget): void {
      const listener = this.#subscriptions.get(target);
      if (!listener) return;
      this.#subscriptions.delete(target);
      this.removeEventListener("signal", listener);
    }

    /** Takes the value of the control that fired `event`. */
    read(control: Control): void {
      this.value = readControl(
        control,
        this.#value,
        () => namedGroup(control),
      ) as Value;
      const name = control.dataset?.bindName || control.name;
      if (name) this.name = name;
    }

    handleEvent(target: unknown, event?: Event | null): this {
      if (event?.type === "input" || event?.type === "change") {
        this.read(event.target as unknown as Control);
      } else if (
        (event?.type === "connect" || event?.type === "load") &&
        target instanceof EventTarget
      ) {
        // A new subscriber sees the current value at once, so a handler
        // bound to `onSignal` needs no separate connect path. `load` is for
        // `<body>` and the other elements the browser fires it on.
        if (this.subscribe(target)) this.deliver(target);
      } else if (event) {
        // Any other event (a click, say) is counted, so subscribers run on
        // each one and the value stays a change to notify about.
        if (typeof this.#value !== "number") {
          throw new TypeError(
            `A signal bound to a ${event.type} event counts those events, so it must hold a number.`,
          );
        }
        this.value = (this.#value + 1) as Value;
      }
      return this;
    }
  }

  class ComputedInstance<Value> extends SignalInstance<Value>
    implements ReadonlySignal<Value> {
    #compute: () => Value;
    #explicit: Set<ReadonlySignal<unknown>>;
    #dependencies = new Set<ReadonlySignal<unknown>>();
    #target = new EventTarget();

    constructor(
      compute: () => Value,
      dependencies: readonly ReadonlySignal<unknown>[] = [],
    ) {
      const initial = runtime ? track(compute) : undefined;
      super(initial ? initial.value : undefined as Value);
      this.#compute = compute;
      this.#explicit = new Set(dependencies);
      if (initial) {
        this.#target.addEventListener("signal", () => this.refresh());
        this.#follow(initial.reads);
      }
    }

    /** Subscribes to the signals the last run read, dropping the rest. */
    #follow(reads: Set<SignalInstance<unknown>>): void {
      const wanted = new Set<ReadonlySignal<unknown>>([
        ...this.#explicit,
        ...reads,
      ]);
      wanted.delete(this);
      for (const dependency of this.#dependencies) {
        if (wanted.has(dependency)) continue;
        dependency.unsubscribe(this.#target);
        this.#dependencies.delete(dependency);
      }
      for (const dependency of wanted) {
        if (this.#dependencies.has(dependency)) continue;
        dependency.subscribe(this.#target);
        this.#dependencies.add(dependency);
      }
    }

    /** Recomputes the value, notifying subscribers if it changed. */
    refresh(): void {
      if (!runtime) return;
      const { value, reads } = track(this.#compute);
      this.#follow(reads);
      super.value = value;
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
   * the first time something inside the root resolves one of its signals
   * (an `onConnect` or `onChange` reference). A nested call makes one group per
   * instance of its parent, holding only the roots inside that instance.
   * An instance is parked when its root's `abortController` aborts, which
   * `UpgradeCustomElement` provides for custom-tag roots: it leaves `.all`
   * and is held only as long as the root element itself lives, so the same
   * element re-inserted later resumes its values while a removed one is
   * collected with its graph. Nothing observes the document.
   */
  class InstanceGroup {
    #define: () => Graph;
    #key: string;
    #selector: string;
    #scope: Element | null | undefined;
    #instances = new Map<Element, Graph>();
    /** Graphs of roots whose controller aborted, kept while the element lives. */
    #parked = new WeakMap<Element, Graph>();
    #aggregates = new Map<string, ComputedInstance<unknown[]>>();
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
        const parked = this.#parked.get(root);
        if (parked) {
          // The same element is back: resume its values under its new controller.
          this.#parked.delete(root);
          this.#activate(root, parked);
          graph = parked;
        } else {
          graph = this.#create(root);
        }
        this.#refreshAggregates();
      }
      return graph;
    }

    /** Lists the graph as live and parks it when the root's controller aborts. */
    #activate(root: Element, graph: Graph): void {
      this.#instances.set(root, graph);
      const abortSignal = (root as { abortController?: AbortController })
        .abortController
        ?.signal;
      abortSignal?.addEventListener("abort", () => {
        this.#instances.delete(root);
        this.#parked.set(root, graph);
        this.#refreshAggregates();
      }, { once: true });
    }

    #create(root: Element): Graph {
      const graph = withScope(root, this.#define);
      this.#activate(root, graph);
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
        // Instances notify the aggregate themselves (see `#create`), so its
        // reads are not tracked: removed instances must not keep it alive.
        aggregate = new ComputedInstance(() =>
          untracked(() => this.#values(name))
        );
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

    unsubscribe(target: Element): void {
      this.for(target).unsubscribe(target);
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

  function signalsFrom(
    initialValues: Record<string, SignalValue>,
  ): Record<string, SignalInstance<SignalValue>> {
    return Object.fromEntries(
      Object.entries(initialValues).map((
        [key, value],
      ) => [key, new SignalInstance(value)]),
    );
  }

  return Object.assign(
    {
      Signal: SignalInstance,
      Computed: ComputedInstance,
      signalsFrom: signalsFrom as SignalTools["signalsFrom"],
      perInstance: perInstance as unknown as SignalTools["perInstance"],
    },
    // Not part of SignalTools: lets the server validate a factory's result.
    { InstanceSignal: InstanceSignalHandle },
  );
}

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };
