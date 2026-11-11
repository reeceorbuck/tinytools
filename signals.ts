/**
 * What a signal may hold.
 *
 * Signals once could also hold elements (or arrays of them). That was removed
 * (2026-10-18) because no use case gained much from it: data-backed elements
 * already have ids to look up, while element values could not be seeded or
 * evaluated on the server and went stale when content was re-rendered. It
 * could be added back if a case turns up where it is a significant
 * improvement, such as reaching elements inside shadow roots that id lookups
 * cannot.
 */
export type SignalValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

/** A signal that can be read and subscribed to, but not written. */
export interface ReadonlySignal<Value = SignalValue> {
  /** The current value; reading it inside a computed makes it a dependency. */
  readonly value: Value;
  /**
   * Optional name, used by handlers such as `setCssProperty`. Set in the
   * factory, or automatically from the `name` of an input whose input/change
   * event writes the signal.
   */
  name?: string;
  /**
   * Runs `target`'s `onSignal` handlers on later changes; it hears nothing
   * until the next one.
   */
  subscribe(target: Element): void;
  /** Ends a subscription made with `subscribe`. */
  unsubscribe(target: Element): void;
}

/** Type-only marker telling writable signals apart from computed ones. */
declare const writableSignal: unique symbol;

/** A writable signal: setting `value` notifies its subscribers. */
export interface Signal<Value = SignalValue> extends ReadonlySignal<Value> {
  /** The current value; setting a different one notifies subscribers. */
  value: Value;
  /** Type-only: marks the signal as writable. */
  readonly [writableSignal]?: true;
}

/** Type-only marker telling triggers apart from other read-only signals. */
declare const triggerSignal: unique symbol;

/**
 * A signal that carries no value, only the fact that something happened:
 * subscribers run each time it fires. `fn.signals.fire(signal.addRow)` fires
 * it once per event, and `fire()` from a handler. Its `value` changes on every fire so
 * dependents notice, but is otherwise meaningless.
 */
export interface Trigger extends ReadonlySignal<unknown> {
  /** Notifies subscribers and dependent computeds. */
  fire(): void;
  /** Type-only: marks the signal as a trigger. */
  readonly [triggerSignal]?: true;
}

/** Type-only marker recording which named `Scope` level a signal belongs to. */
declare const instanceLevel: unique symbol;

/**
 * A signal defined inside a `Scope`: every instance root (an element whose
 * `tt-instance` attribute holds the level's key) gets its own copy.
 * Bound in JSX (`onChange={fn.signals.update(signal.name)}`, `onConnect={fn.signals.subscribe(signal.name)}`,
 * `onClick={fn.signals.add(signal.name)}`) it resolves to the instance enclosing the
 * element, so markup needs nothing extra.
 * `Level` is the key its `Scope` is returned under, or `never` for one the
 * factory returns directly.
 */
export interface InstanceSignal<
  Value = SignalValue,
  Instance extends ReadonlySignal<Value> = Signal<Value>,
  Level extends string = never,
> {
  /** Optional name, as on the signals of each instance. */
  name?: string;
  /** The signal of the instance enclosing `element`. */
  forInstance(element: Element): Instance;
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
  /** Type-only: the named `Scope` level this signal belongs to. */
  readonly [instanceLevel]?: Level;
}

// deno-lint-ignore no-explicit-any
type AnyInstanceSignal = InstanceSignal<any, any, any>;

/**
 * What a signal of type `S` holds, as the `fn.signals` handlers check it:
 * every signal `reads` its value, a writable one also `writes` it and a
 * trigger `fires`. `fn.signals.add` takes signals that write a number,
 * `toggle` ones that write a boolean. A per-instance signal holds what its
 * instances hold.
 */
export type SignalHolding<S> = S extends // deno-lint-ignore no-explicit-any
InstanceSignal<any, infer Instance, any> ? SignalHolding<Instance>
  : typeof triggerSignal extends keyof S
    ? { readonly reads: unknown; readonly fires: true }
  : S extends ReadonlySignal<infer Value>
    ? typeof writableSignal extends keyof S
      ? { readonly reads: Value; readonly writes: Value }
    : { readonly reads: Value }
  : never;

/**
 * The per-instance handles a `Scope` holds, one per signal it defines.
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

/** Type-only marker telling a `Scope` apart from the signals it holds. */
declare const scopeSignals: unique symbol;

/** Any `Scope`, as a factory or another `Scope` may return it. */
type AnyScope = { readonly [scopeSignals]: true };

/**
 * What `new Scope(define)` makes: a per-instance handle for each signal
 * `define` returns, so a computed beside it can read `scope.name.all`.
 * Returned from the factory directly it is the unnamed level; returned
 * under a key (`{ box: new Scope(...) }`) the level is named after the key.
 * Either way its signals are exported under their own names.
 */
export type Scope<Definitions = Record<string, never>> =
  & InstanceSignals<FlattenScopes<Definitions>>
  & AnyScope;

// deno-lint-ignore no-explicit-any
type UnionToIntersection<U> = (U extends any ? (u: U) => void : never) extends
  (i: infer I) => void ? I : never;

/** The signals of a `Scope` returned under the key `Level`. */
type Leveled<S, Level extends string> = {
  [Name in keyof S as Name extends typeof scopeSignals ? never : Name]:
    S[Name] extends { readonly [instanceLevel]?: infer Own }
      ? [Exclude<Own, undefined>] extends [never]
        // deno-lint-ignore no-explicit-any
        ? S[Name] extends InstanceSignal<infer Value, infer Instance, any>
          ? InstanceSignal<Value, Instance, Level>
        : S[Name]
      : S[Name]
      : S[Name];
};

type Flattened<T> = { [Name in keyof T]: T[Name] };

/** The signals of every `Scope` among `Definitions`, each of its key's level. */
type ScopeMembers<Definitions> = UnionToIntersection<
  {
    [Name in keyof Definitions]: typeof scopeSignals extends
      keyof Definitions[Name] ? Leveled<Definitions[Name], Name & string>
      : never;
  }[keyof Definitions]
>;

/**
 * Definitions as a factory or a `Scope` exports them: each `Scope` among
 * them replaced by its signals, of the level named after its key. A
 * `Scope` returned directly is the unnamed level.
 */
export type FlattenScopes<Definitions> = typeof scopeSignals extends
  keyof Definitions ? Omit<Definitions, typeof scopeSignals>
  : Flattened<
    & {
      [
        Name in keyof Definitions as typeof scopeSignals extends
          keyof Definitions[Name] ? never : Name
      ]: Definitions[Name];
    }
    & ScopeMembers<Definitions>
  >;

/** What a `Scope` callback may return: signals, nested per-instance signals and nested scopes. */
export type InstanceDefinitions = Record<
  string,
  | ReadonlySignal<unknown>
  | InstanceSignal<unknown, ReadonlySignal<unknown>, string>
  | AnyScope
>;

/**
 * The named `Scope` levels of a collection's signals: the keys `scopes`
 * accepts. A level counts once at least one of its signals is exported.
 */
export type InstanceLevels<Definitions> = {
  [Name in keyof Definitions]: Definitions[Name] extends
    { readonly [instanceLevel]?: infer Level } ? Exclude<Level, undefined>
    : never;
}[keyof Definitions];

/** The toolkit a `tiny.Signals` factory receives to define its signals. */
export interface SignalTools {
  /** A writable signal holding a value, starting at `initialValue`. */
  Signal: {
    /**
     * The value type is inferred widened (`new Signal(0)` is a
     * `Signal<number>`, not `Signal<0>`). `Value` is left unconstrained
     * because a constraint naming primitives makes TypeScript keep the
     * literal; the parameter's `& SignalValue` does the checking instead.
     */
    new <Value>(initialValue: Value & SignalValue): Signal<Value>;
    /**
     * Without an initial value a signal starts as `null`, so that is only
     * allowed when the value type includes `null`.
     */
    new <Value extends SignalValue = SignalValue>(
      ...args: null extends Value ? [] : [initialValue: Value]
    ): Signal<Value>;
  };
  /**
   * A signal with no value of its own, for one element to tell others that
   * something happened (a button asking a list to add a row).
   */
  Trigger: new () => Trigger;
  /**
   * A read-only signal recomputed whenever a signal its callback read
   * changes. Dependencies are tracked on every run, so reads behind
   * conditions count only while taken. `dependencies` may list extra signals
   * to follow (for example ones read only inside an untracked helper).
   * `compute` receives the previous value: `undefined` on the first run.
   */
  Computed: {
    new <Value>(
      compute: (previous: Value | undefined) => Value,
      dependencies?: readonly ReadonlySignal<unknown>[],
    ): ReadonlySignal<Value>;
    /**
     * Starts at `initialValue` without running `compute`, which first runs
     * when one of `dependencies` changes, so list every signal it should
     * follow there. Suits a value that only steps from its previous one on
     * each change (`new Computed((hue) => (hue + 90) % 360, [press], 0)`).
     */
    new <Value>(
      compute: (previous: Value) => Value,
      dependencies: readonly ReadonlySignal<unknown>[],
      initialValue: Value & SignalValue,
    ): ReadonlySignal<Value>;
  };
  /**
   * One writable signal per entry of `initialValues`, under the same key and
   * typed from its value, so an object of defaults (usually from `constants`)
   * becomes a set of signals in one call. Spread the result into the
   * collection, or keep it and read `signals.name.value`.
   */
  signalsFrom<Values extends Record<string, SignalValue>>(
    initialValues: Values,
  ): { [Key in keyof Values]: Signal<Values[Key]> };
  /**
   * Defines signals that every instance root gets its own copy of. `define`
   * runs once per instance, so `Signal`s and `Computed`s inside it see only
   * that instance's values. Returned from the factory directly it is the
   * unnamed level, whose roots carry `tt-instance={collection.instanceKey}`.
   * Returned under a key (`{ box: new Scope(...) }`), from the factory or
   * from another `Scope`, the level is named after the key and its roots
   * carry `tt-instance={collection.scopes.box.key}`. A nested level has one
   * group per parent instance, whose `.all` covers only the roots inside
   * that parent. Either way its signals are exported by their own names.
   */
  Scope: new <Definitions extends InstanceDefinitions>(
    define: () => Definitions,
  ) => Scope<Definitions>;
}

/** What a Signals factory returns: its signals, per-instance signals and scopes. */
export type SignalDefinitions = Record<
  string,
  | ReadonlySignal<unknown>
  | InstanceSignal<unknown, ReadonlySignal<unknown>, string>
  | AnyScope
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

/**
 * A collection's signals as it exports them: one accessor per signal, a
 * function returning that signal, so each can be referenced like any handler.
 */
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
 * The values an instance root can start its instance with: the writable
 * signals of one `Scope` level (`Level` is its name, `never` for the
 * unnamed top level). Seeds travel as JSON.
 */
export type InstanceSeed<
  Definitions extends SignalDefinitions,
  Level extends string = never,
> = {
  [
    Name in keyof Definitions as Definitions[Name] extends // deno-lint-ignore no-explicit-any
    InstanceSignal<any, infer Instance, infer NameLevel>
      ? [NameLevel] extends [Level]
        ? [Level] extends [NameLevel]
          ? typeof writableSignal extends keyof Instance ? Name : never
        : never
      : never
      : never
  ]?: Definitions[Name] extends // deno-lint-ignore no-explicit-any
  InstanceSignal<infer Value, any, any> ? Value
    : never;
};

/**
 * The values `evaluateUsingInitialValues` can start a collection's instances
 * from: writable signals of any level, each level taking its own names. A
 * nested level starts fresh, so naming one of its signals throws when the
 * evaluation runs.
 */
export type EvaluationSeed<Definitions extends SignalDefinitions> = {
  [
    Name in keyof Definitions as Definitions[Name] extends // deno-lint-ignore no-explicit-any
    InstanceSignal<any, infer Instance, any>
      ? typeof writableSignal extends keyof Instance ? Name : never
      : never
  ]?: Definitions[Name] extends // deno-lint-ignore no-explicit-any
  InstanceSignal<infer Value, any, any> ? Value
    : never;
};

// ============================================================================
// Runtime
//
// The classes below are the signal runtime itself, used as they are on the
// server and shipped to the browser as source (see `signalModules.ts`), split
// into modules by feature so a page only loads what its collections use:
// `Signal` and `signalsFrom` (always), `Computed`, `Trigger` and
// `Scope`. Each shipped function may therefore only use the DOM, `tiny`
// and the names its module declares or imports: see `signalModules.ts`.
// ============================================================================

/** Signals read while a computed callback runs, so it can follow them. */
let tracking: Set<SignalInstance<unknown>> | null = null;

/** Runs `compute`, recording the signals it reads. */
export function track<Value>(
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

/** Runs `read` without recording its reads in an enclosing computed. */
export function untracked<Value>(read: () => Value): Value {
  const previous = tracking;
  tracking = null;
  try {
    return read();
  } finally {
    tracking = previous;
  }
}

/** @internal Equal values do not notify; arrays compare by their items. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((item, index) => Object.is(item, b[index]));
}

export class SignalInstance<Value = SignalValue> extends EventTarget
  implements Signal<Value> {
  name?: string;
  #value: Value;
  #subscriptions = new WeakMap<
    Element,
    { listener: EventListener; fire: EventListener }
  >();

  constructor(initialValue: Value = null as Value) {
    super();
    this.#value = initialValue;
  }

  get value(): Value {
    tracking?.add(this as SignalInstance<unknown>);
    return this.#value;
  }

  set value(value: Value) {
    if (sameValue(this.#value, value)) return;
    this.#value = value;
    this.dispatchEvent(this.createEvent());
  }

  createEvent(): Event {
    return Object.assign(new Event("signal"), { signal: this });
  }

  /**
   * Subscribing sends nothing: the element hears of changes only, until its
   * `abortController` aborts. A `tt-fire-signals` event on it
   * (`signalTools.fireSelfSignal`) sends it the current value. Subscribing
   * again changes nothing. Computeds listen to their dependencies directly.
   */
  subscribe(target: Element): void {
    if (this.#subscriptions.has(target)) return;
    const abortSignal = (target as { abortController?: AbortController })
      .abortController?.signal;
    if (abortSignal?.aborted) return;
    const listener = (event: Event) =>
      tiny.runHandler(target as HTMLElement, event);
    const fire = () => listener(this.createEvent());
    this.#subscriptions.set(target, { listener, fire });
    this.addEventListener("signal", listener, { signal: abortSignal });
    target.addEventListener("tt-fire-signals", fire, { signal: abortSignal });
    abortSignal?.addEventListener(
      "abort",
      () => this.#subscriptions.delete(target),
      { once: true },
    );
  }

  unsubscribe(target: Element): void {
    const subscription = this.#subscriptions.get(target);
    if (!subscription) return;
    this.#subscriptions.delete(target);
    this.removeEventListener("signal", subscription.listener);
    target.removeEventListener("tt-fire-signals", subscription.fire);
  }
}

export function signalsFrom(
  initialValues: Record<string, SignalValue>,
): Record<string, SignalInstance<SignalValue>> {
  return Object.fromEntries(
    Object.entries(initialValues).map((
      [key, value],
    ) => [key, new SignalInstance(value)]),
  );
}

/**
 * The signals of a shape, as `tiny.Signals(tools, define)` and its
 * `Scope` return it: each function a computed whose `this` is the
 * shape's own signals, each initial value a writable signal, and anything
 * already built kept. Computeds run when built, so each is built when first
 * read: one may read a sibling declared after it. A `Scope` in it is kept,
 * so `this.box` is that Scope and `this.box.name` one of its signals; one
 * returned instead of a shape is returned as it is. The classes are passed
 * in so the server can check a factory with inert computeds.
 */
export function shapeSignals(
  shape: Record<string, unknown>,
  Signal: new (value: unknown) => unknown,
  Computed: new (compute: () => unknown) => unknown,
): Record<string, unknown> {
  if (Object.getPrototypeOf(shape) !== Object.prototype) return shape;
  const signals: Record<string, unknown> = {};
  const pending = new Map<string | symbol, () => unknown>();
  const own = new Proxy(signals, {
    get(target, name) {
      if (pending.has(name)) build(name as string);
      return target[name as string];
    },
  });
  function build(name: string) {
    const compute = pending.get(name)!;
    pending.delete(name);
    signals[name] = new Computed(() => compute.call(own));
  }
  for (const [name, value] of Object.entries(shape)) {
    if (typeof value === "function") pending.set(name, value as () => unknown);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      signals[name] = value;
    } else signals[name] = new Signal(value);
  }
  for (const name of [...pending.keys()]) {
    if (pending.has(name)) build(name as string);
  }
  return Object.fromEntries(
    Object.keys(shape).map((name) => [name, signals[name]]),
  );
}

export class TriggerInstance extends SignalInstance<number> implements Trigger {
  constructor() {
    super(0);
  }

  fire(): void {
    super.value++;
  }

  override get value(): number {
    return super.value;
  }

  override set value(_value: number) {
    throw new TypeError("Triggers have no value to set: call `fire()`.");
  }
}

export class ComputedInstance<Value> extends SignalInstance<Value>
  implements ReadonlySignal<Value> {
  #compute: (previous: Value | undefined) => Value;
  /** Signals are EventTargets, which a computed listens to directly. */
  #explicit: readonly EventTarget[];
  #dependencies = new Set<EventTarget>();
  #refresh = () => this.refresh();

  /** With `initialValue`, `compute` waits for a change of `dependencies`. */
  constructor(
    compute: (previous: Value | undefined) => Value,
    dependencies: readonly ReadonlySignal<unknown>[] = [],
    ...initialValue: [] | [Value]
  ) {
    const initial = initialValue.length
      ? { value: initialValue[0] as Value, reads: new Set<never>() }
      : track(() => compute(undefined));
    super(initial.value);
    this.#compute = compute;
    this.#explicit = dependencies as unknown as readonly EventTarget[];
    this.#follow(initial.reads);
  }

  /** Listens to the signals the last run read, dropping the rest. */
  #follow(reads: Set<EventTarget>): void {
    const wanted = new Set([...this.#explicit, ...reads]);
    wanted.delete(this);
    for (const dependency of this.#dependencies) {
      if (!wanted.has(dependency)) {
        dependency.removeEventListener("signal", this.#refresh);
      }
    }
    // Adding a listener a dependency already has changes nothing.
    for (const dependency of wanted) {
      dependency.addEventListener("signal", this.#refresh);
    }
    this.#dependencies = wanted;
  }

  /** Recomputes the value, notifying subscribers if it changed. */
  refresh(): void {
    // Reading its own value is no dependency: `#follow` drops `this`.
    const { value, reads } = track(() => this.#compute(super.value));
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
 * Where a `Scope` is being made: `undefined` at the top of the factory
 * (instances span the document), `null` while building a detached template
 * (inert), or the instance root of the enclosing `Scope` (nested instances
 * live inside it).
 */
let currentScope: Element | null | undefined;

/** @internal Runs `run` with `scope` as the current `Scope` root. */
export function withScope<Result>(
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
 * @internal One `Scope`: a copy of its graph per instance root, created
 * the first time something inside the root resolves one of its signals
 * (an `onConnect` or `onChange` reference). A nested call makes one group per
 * instance of its parent, holding only the roots inside that instance.
 * An instance is parked when its root's `abortController` aborts, which
 * lifecycle elements provide: it leaves `.all` and is held only as long as
 * the root element itself lives, so the same element re-inserted later
 * resumes its values while a removed one is collected with its graph.
 * Nothing observes the document.
 */
export class InstanceGroup {
  #define: () => Graph;
  /** The collection's instance key, which the level's key starts with. */
  #base: string;
  /** Set once the `Scope` is returned (see `flattenScopes`). */
  #key: string | undefined;
  #scope: Element | null | undefined;
  #instances = new Map<Element, Graph>();
  /** Instances shared by linked elements, by link id. */
  #linked = new Map<string, { graph: Graph; members: Set<Element> }>();
  /** Graphs of roots whose controller aborted, kept while the element lives. */
  #parked = new WeakMap<Element, Graph>();
  /** `.all` of each signal, recomputed whenever an instance changes. */
  #aggregates = new Map<string, SignalInstance<unknown[]>>();
  /** A detached copy listing the signal names and server-side values. */
  readonly template: Graph;

  /** The `tt-instance` key of this group's roots. */
  get key(): string {
    if (this.#key === undefined) {
      throw new Error(
        "These per-instance signals belong to a Scope that is not returned: return it from the factory, or under a key ({ box: new Scope(...) }).",
      );
    }
    return this.#key;
  }

  /** Whether the `Scope` has been returned, which gives its level a key. */
  get named(): boolean {
    return this.#key !== undefined;
  }

  constructor(define: () => Graph, instanceKey: string) {
    this.#define = () => InstanceGroup.#named(flattenScopes(define(), true));
    this.#base = instanceKey;
    this.#scope = currentScope;
    this.template = withScope(null, this.#define);
  }

  /**
   * Keys the level: the collection's `instanceKey` for the unnamed level,
   * `<instanceKey>-<level>` for one returned under the key `level`.
   */
  name(level?: string): void {
    if (this.#key !== undefined) {
      throw new TypeError(
        `A Scope can be returned once; '${level ?? "it"}' returns it again.`,
      );
    }
    this.#key = level ? `${this.#base}-${level}` : this.#base;
  }

  /**
   * The graph of the instance enclosing `element`. An element whose `tt-link`
   * names this group (`<key>=<link id>`) belongs to that linked instance
   * instead, shared by every element naming the same link wherever it sits,
   * so a control outside a component can drive one of its instances.
   */
  instanceFor(element: Element): Graph {
    const key = this.key;
    const selector = `[tt-instance~="${key}"], [tt-link*="${key}="]`;
    let root = element?.closest?.(selector);
    while (root && !root.matches(`[tt-instance~="${key}"]`)) {
      const link = this.#linkOf(root);
      if (link) return this.#linkedGraph(link, root);
      root = root.parentElement?.closest(selector) ?? null;
    }
    if (!root || (this.#scope && !this.#scope.contains(root))) {
      throw new Error(
        `Per-instance signals must be used inside an instance root: an element with tt-instance="${key}" (the collection's \`instanceKey\`, or \`scopes.<name>.key\` for a Scope returned under a key).`,
      );
    }
    let graph = this.#instances.get(root);
    if (!graph) {
      // The same element back again resumes its values under its new controller.
      graph = this.#parked.get(root) ?? this.#create(root);
      this.#parked.delete(root);
      this.#instances.set(root, graph);
      (root as { abortController?: AbortController }).abortController?.signal
        .addEventListener("abort", () => {
          this.#instances.delete(root!);
          this.#parked.set(root!, graph!);
          this.#refreshAggregates();
        }, { once: true });
      this.#refreshAggregates();
    }
    return graph;
  }

  /** The link id `element`'s `tt-link` gives this group, if any. */
  #linkOf(element: Element): string | undefined {
    const prefix = `${this.key}=`;
    return element.getAttribute("tt-link")?.split(/\s+/)
      .find((token) => token.startsWith(prefix))?.slice(prefix.length);
  }

  /**
   * The instance shared by every element linked as `link`. It lives as long
   * as the page, so members removed and inserted again keep its values.
   */
  #linkedGraph(link: string, member: Element): Graph {
    let linked = this.#linked.get(link);
    if (!linked) {
      // Its members sit anywhere, so nested levels are not confined to one.
      linked = { graph: this.#create(null), members: new Set() };
      this.#linked.set(link, linked);
    }
    if (!linked.members.has(member)) {
      linked.members.add(member);
      this.#refreshAggregates();
    }
    return linked.graph;
  }

  #create(root: Element | null): Graph {
    const graph = withScope(root, this.#define);
    const seed = root?.getAttribute("tt-seed");
    if (seed) {
      try {
        InstanceGroup.#write(
          graph,
          JSON.parse(seed)?.[this.key] ?? {},
          (message) => console.error(message),
        );
      } catch {
        console.error("Ignoring malformed tt-seed:", seed);
      }
    }
    for (const [name, signal] of Object.entries(graph)) {
      // Nested per-instance signals are aggregated by their own group.
      if (!(signal instanceof SignalInstance)) continue;
      signal.addEventListener("signal", () => {
        const aggregate = this.#aggregates.get(name);
        if (aggregate) aggregate.value = this.#values(name);
      });
    }
    return graph;
  }

  /**
   * A detached instance started from `values`, as the server renders a
   * seeded root: `evaluateUsingInitialValues` reads its signals, so
   * computeds there see the seed. Nested levels inside it start fresh.
   * Names of other groups of the collection are left to those groups.
   */
  seeded(values: Record<string, unknown>): Graph {
    const graph = withScope(null, this.#define);
    const own = Object.fromEntries(
      Object.entries(values).filter(([name]) => Object.hasOwn(graph, name)),
    );
    InstanceGroup.#write(graph, own, (message) => {
      throw new TypeError(message);
    });
    return graph;
  }

  /**
   * Writes seed values (from a root's `tt-seed`, written by
   * `collection.seed()` as `{ [key]: values }`) into an instance's writable
   * signals: plain signals, not computeds or triggers.
   */
  static #write(
    graph: Graph,
    values: Record<string, unknown>,
    report: (message: string) => void,
  ): void {
    for (const [name, value] of Object.entries(values)) {
      const signal = graph[name];
      if (signal?.constructor !== SignalInstance) {
        report(
          `Cannot seed '${name}': it is not a writable signal of this Scope level.`,
        );
        continue;
      }
      (signal as SignalInstance<unknown>).value = value;
    }
  }

  aggregate(name: string): SignalInstance<unknown[]> {
    if (this.template[name] instanceof InstanceSignalHandle) {
      throw new TypeError(
        "`.all` is not available for a nested per-instance signal here: read it inside the enclosing Scope, where it covers that instance.",
      );
    }
    let aggregate = this.#aggregates.get(name);
    if (!aggregate) {
      aggregate = new SignalInstance(this.#values(name));
      this.#aggregates.set(name, aggregate);
    }
    return aggregate;
  }

  /**
   * Every connected instance's value in document order. Instances notify
   * the aggregate themselves (see `#create`), so the reads are not tracked:
   * removed instances must not keep a computed reading `.all` alive.
   */
  #values(name: string): unknown[] {
    return untracked(() => {
      // A linked instance counts once, at its first connected member.
      const placed: [Element, Graph][] = [...this.#instances]
        .filter(([root]) => root.isConnected);
      for (const { graph, members } of this.#linked.values()) {
        const first = [...members].filter((member) => member.isConnected)
          .sort(InstanceGroup.#documentOrder)[0];
        if (first) placed.push([first, graph]);
      }
      return placed.sort(([a], [b]) => InstanceGroup.#documentOrder(a, b))
        .map(([, graph]) => (graph[name] as SignalInstance<unknown>).value);
    });
  }

  /** Names each signal of `graph` that has no name after its key. */
  static #named(graph: Graph): Graph {
    for (const [name, signal] of Object.entries(graph ?? {})) {
      if (signal instanceof SignalInstance) signal.name ??= name;
    }
    return graph;
  }

  static #documentOrder(a: Element, b: Element): number {
    return a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */
      ? -1
      : 1;
  }

  #refreshAggregates(): void {
    for (const [name, aggregate] of this.#aggregates) {
      aggregate.value = this.#values(name);
    }
  }
}

export class InstanceSignalHandle<Value = unknown>
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

  /** @internal The group this signal belongs to. */
  get group(): InstanceGroup {
    return this.#group;
  }

  forInstance(element: Element): SignalInstance<Value> {
    const signal = this.#group.instanceFor(element)[this.#name];
    // A nested signal resolves its own, inner instance next.
    return signal instanceof InstanceSignalHandle
      ? signal.forInstance(element) as SignalInstance<Value>
      : signal as SignalInstance<Value>;
  }

  get all(): ReadonlySignal<Value[]> {
    return this.#group.aggregate(this.#name) as ReadonlySignal<Value[]>;
  }

  /**
   * The value in an instance started from `seed`, as
   * `evaluateUsingInitialValues` reports a seeded root. `instances` holds
   * the instance built for each group, so signals of one group share it.
   */
  seededValue(
    seed: Record<string, unknown>,
    instances: Map<InstanceGroup, Graph>,
  ): Value {
    let graph = instances.get(this.#group);
    if (!graph) {
      graph = this.#group.seeded(seed);
      instances.set(this.#group, graph);
    }
    const signal = graph[this.#name];
    return (signal instanceof InstanceSignalHandle
      ? signal.initialValue
      : signal.value) as Value;
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
      "Per-instance signals have a value per instance: read `.forInstance(element).value`, or `.all.value` for every instance.",
    );
  }

  subscribe(target: Element): void {
    this.forInstance(target).subscribe(target);
  }

  unsubscribe(target: Element): void {
    this.forInstance(target).unsubscribe(target);
  }

  /** @internal The signal a fresh instance defines under this name. */
  get templateSignal(): SignalInstance<unknown> | InstanceSignalHandle {
    return this.#group.template[this.#name];
  }
}

/** What a signal is, for which `fn.signals` handlers take it. */
export type SignalKind = "trigger" | "writable" | "computed";

/**
 * @internal The kind of `signal` (a per-instance one's instances' kind).
 * Read from a factory's server-side (inert) run, where computeds are not
 * `SignalInstance` itself.
 */
export function signalKind(signal: unknown): SignalKind {
  if (signal instanceof InstanceSignalHandle) {
    return signalKind(signal.templateSignal);
  }
  if (signal instanceof TriggerInstance) return "trigger";
  return signal?.constructor === SignalInstance ? "writable" : "computed";
}

/**
 * A `Scope`: one per-instance handle per signal its callback returns, kept
 * as its own properties so a computed beside it reads `scope.name.all`.
 * Its level has no key until it is returned (see `flattenScopes`).
 */
export class ScopeInstance {
  #group: InstanceGroup;

  constructor(instanceKey: string, define: () => Graph) {
    const group = new InstanceGroup(define, instanceKey);
    for (const signal of Object.values(group.template)) {
      if (
        !(signal instanceof SignalInstance) &&
        !(signal instanceof InstanceSignalHandle)
      ) {
        throw new TypeError(
          "A Scope's callback must synchronously return an object of Signal, Computed or nested Scope signals.",
        );
      }
    }
    this.#group = group;
    for (const name of Object.keys(group.template)) {
      (this as Record<string, unknown>)[name] = new InstanceSignalHandle(
        group,
        name,
      );
    }
  }

  /** @internal The group of `scope`'s level. */
  static groupOf(scope: ScopeInstance): InstanceGroup {
    return scope.#group;
  }
}

/**
 * The `Scope` of the collection whose instance roots carry `instanceKey`
 * (named levels carry `<instanceKey>-<name>`).
 */
export function scopeFor(instanceKey: string): SignalTools["Scope"] {
  return class Scope extends ScopeInstance {
    constructor(define: () => Graph) {
      super(instanceKey, define);
    }
  } as unknown as SignalTools["Scope"];
}

/**
 * What a factory (or, with `nested`, a `Scope`'s callback) returned, as it
 * is exported: each `Scope` in it replaced by its signals, its level named
 * after its key. A `Scope` returned directly is the unnamed level, which
 * only the factory may return. Anything that is not an object is left for
 * the caller to reject.
 */
export function flattenScopes(definitions: unknown, nested = false): Graph {
  if (
    !definitions || typeof definitions !== "object" ||
    definitions instanceof Promise
  ) {
    return definitions as Graph;
  }
  if (definitions instanceof ScopeInstance) {
    if (nested) {
      throw new TypeError(
        "A nested Scope must be returned under a key, e.g. { box: new Scope(() => ...) }, so its roots can be told apart from its parent's.",
      );
    }
    ScopeInstance.groupOf(definitions).name();
    return { ...definitions } as Graph;
  }
  const flat: Graph = {};
  for (const [key, value] of Object.entries(definitions)) {
    if (value instanceof ScopeInstance) ScopeInstance.groupOf(value).name(key);
    const entries = value instanceof ScopeInstance
      ? Object.entries(value)
      : [[key, value]];
    for (const [name, signal] of entries) {
      if (Object.hasOwn(flat, name)) {
        throw new TypeError(
          `'${name}' is defined twice: each signal, including those of every Scope returned, needs its own name.`,
        );
      }
      if (signal instanceof InstanceSignalHandle && !signal.group.named) {
        throw new TypeError(
          `'${name}' belongs to a Scope that is spread or copied: return the Scope itself, under a key ({ box: new Scope(...) }).`,
        );
      }
      flat[name] = signal;
    }
  }
  return flat;
}

/**
 * A computed that never computes, for the server's first run of a factory,
 * which only lists and checks its signals: computed callbacks may need
 * browser globals.
 */
class InertComputed<Value> extends SignalInstance<Value> {
  constructor(_compute: unknown, _dependencies: unknown, initialValue?: Value) {
    super(initialValue as Value);
  }
}

/** The toolkit a collection's factory receives, with the per-instance handle class. */
export type InternalSignalTools = SignalTools & {
  InstanceSignal: typeof InstanceSignalHandle;
  shapeSignals: typeof shapeSignals;
};

/**
 * The signal toolkit for one collection, as a factory receives it.
 * `instanceKey` identifies that collection's instance roots: elements whose
 * space-separated `tt-instance` attribute includes it. With `runtime` false
 * computeds stay inert, for checking a factory without running it.
 */
export function signalClasses(
  runtime = true,
  instanceKey = "",
): InternalSignalTools {
  return {
    Signal: SignalInstance as unknown as SignalTools["Signal"],
    Trigger: TriggerInstance,
    Computed:
      (runtime ? ComputedInstance : InertComputed) as unknown as SignalTools[
        "Computed"
      ],
    signalsFrom: signalsFrom as SignalTools["signalsFrom"],
    Scope: scopeFor(instanceKey),
    InstanceSignal: InstanceSignalHandle,
    shapeSignals,
  };
}

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };
