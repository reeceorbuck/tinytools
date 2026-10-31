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
  /** Sends `target` later changes; it hears nothing until the next one. */
  subscribe(target: EventTarget): void;
  /** Ends a subscription made with `subscribe`. */
  unsubscribe(target: EventTarget): void;
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
 * subscribers run each time it fires. Bound as a handler to any event other
 * than `connect`/`load` (`onClick={signal.addRow}`) it fires once per event;
 * `fire()` fires it from a handler. Its `value` changes on every fire so
 * dependents notice, but is otherwise meaningless.
 */
export interface Trigger extends ReadonlySignal<unknown> {
  /** Notifies subscribers and dependent computeds. */
  fire(): void;
  /** Type-only: marks the signal as a trigger. */
  readonly [triggerSignal]?: true;
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
  /** Type-only: the named `perInstance` level this signal belongs to. */
  readonly [instanceLevel]?: Level;
}

// deno-lint-ignore no-explicit-any
type AnyInstanceSignal = InstanceSignal<any, any, any>;

/** What a signal reference can do as a JSX handler: `signal.name.<action>`. */
export type SignalAction = "update" | "toggle" | "fire";

/**
 * The actions a signal of type `S` offers (see `signalActions`): `fire` for
 * a trigger, `update` for a writable signal and `toggle` too for a boolean
 * one, none for a computed. A per-instance signal offers its instance's.
 */
export type SignalActionsOf<S> = S extends // deno-lint-ignore no-explicit-any
InstanceSignal<any, infer Instance, any> ? SignalActionsOf<Instance>
  : typeof triggerSignal extends keyof S ? "fire"
  : typeof writableSignal extends keyof S ?
      | "update"
      | (S extends Signal<infer Value>
        ? [Value] extends [boolean] ? "toggle" : never
        : never)
  : never;

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
  /** Defines signals that every instance root gets its own copy of. */
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

/** What a Signals factory returns: its signals and per-instance signals. */
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
 * signals of one `perInstance` level (`Level` is its name, `never` for the
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

// ============================================================================
// Runtime
//
// The classes below are the signal runtime itself, used as they are on the
// server and shipped to the browser as source (see `signalModules.ts`), split
// into modules by feature so a page only loads what its collections use:
// `Signal` and `signalsFrom` (always), `Computed`, `Trigger` and
// `perInstance`. Each shipped function may therefore only use the DOM, `tiny`
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

/** The parts of a form control the runtime reads. */
export type Control = {
  type?: string;
  name?: string;
  value: string;
  checked?: boolean;
  multiple?: boolean;
  selectedOptions?: ArrayLike<{ value: string }>;
  form?: HTMLFormElement | null;
};

/**
 * @internal A control's value in the shape of the signal's current value: checkboxes
 * write `checked` to a boolean signal and otherwise the checked values of
 * their group (the inputs sharing their form and name), a multiple select its
 * selected values, and a numeric signal reads a number.
 */
export function readControl(control: Control, current: unknown): unknown {
  if (control.type === "checkbox") {
    if (typeof current === "boolean") return !!control.checked;
    const named = control.name
      ? control.form?.elements.namedItem(control.name)
      : null;
    const group = typeof RadioNodeList !== "undefined" &&
        named instanceof RadioNodeList
      ? Array.from(named) as unknown as Control[]
      : [control];
    return group.filter((input) => input.checked).map((input) => input.value);
  }
  if (control.multiple && control.selectedOptions) {
    return Array.from(control.selectedOptions, (option) => option.value);
  }
  if (typeof current === "number") {
    return control.value === "" ? NaN : Number(control.value);
  }
  return control.value;
}

export class SignalInstance<Value = SignalValue> extends EventTarget
  implements Signal<Value> {
  name?: string;
  #value: Value;
  #subscriptions = new WeakMap<
    EventTarget,
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
   * Returns whether a new subscription was made. Subscribing sends nothing:
   * the target hears of changes only. A `tt-fire-signals` event on the
   * target (`signalTools.fireSelfSignal`) sends it the current value.
   */
  subscribe(target: EventTarget): boolean {
    if (this.#subscriptions.has(target)) return false;
    const abortSignal = (target as { abortController?: AbortController })
      .abortController?.signal;
    if (abortSignal?.aborted) return false;
    // Elements run their `onSignal` handlers; other targets (a computed's)
    // hear the event itself.
    const listener = (event: Event) =>
      typeof HTMLElement !== "undefined" && target instanceof HTMLElement
        ? tiny.runHandler(target, event)
        : target.dispatchEvent(this.createEvent());
    const fire = () => listener(this.createEvent());
    this.#subscriptions.set(target, { listener, fire });
    this.addEventListener("signal", listener, { signal: abortSignal });
    target.addEventListener("tt-fire-signals", fire, { signal: abortSignal });
    abortSignal?.addEventListener(
      "abort",
      () => this.#subscriptions.delete(target),
      { once: true },
    );
    return true;
  }

  unsubscribe(target: EventTarget): void {
    const subscription = this.#subscriptions.get(target);
    if (!subscription) return;
    this.#subscriptions.delete(target);
    this.removeEventListener("signal", subscription.listener);
    target.removeEventListener("tt-fire-signals", subscription.fire);
  }

  /** Takes the value of `control`, and its name when it has one. */
  read(control: Control): void {
    this.value = readControl(control, this.#value) as Value;
    if (control.name) this.name = control.name;
  }

  /** As a handler (`onInput={signal.size.update}`), reads the event's control. */
  update(_target: unknown, event?: Event | null): void {
    if (event) this.read(event.target as unknown as Control);
  }

  /** Flips a boolean signal (`onClick={signal.open.toggle}`). */
  toggle(): void {
    if (typeof this.#value !== "boolean") {
      throw new TypeError(
        `Only a boolean signal can be toggled: '${this.name}' holds a ${typeof this
          .#value}.`,
      );
    }
    this.value = !this.#value as Value;
  }

  handleEvent(target: unknown, event?: Event | null): this {
    if (event?.type === "input" || event?.type === "change") {
      this.read(event.target as unknown as Control);
    } else if (
      (event?.type === "connect" || event?.type === "load") &&
      target instanceof EventTarget
    ) {
      // Subscribing only listens: `onSignal` runs on the next change, not
      // now. `load` is for `<body>` and the other elements the browser
      // fires it on.
      this.subscribe(target);
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
 * `perInstance` return it: each function a computed whose `this` is the
 * shape's own signals, each initial value a writable signal, and anything
 * already built kept. Computeds run when built, so each is built when first
 * read: one may read a sibling declared after it. The classes are passed in
 * so the server can check a factory with inert computeds.
 */
export function shapeSignals(
  shape: Record<string, unknown>,
  Signal: new (value: unknown) => unknown,
  Computed: new (compute: () => unknown) => unknown,
): Record<string, unknown> {
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

  /** Every event fires it, except the ones that subscribe. */
  override handleEvent(target: unknown, event?: Event | null): this {
    if (
      (event?.type === "connect" || event?.type === "load") &&
      target instanceof EventTarget
    ) {
      this.subscribe(target);
    } else if (event) {
      this.fire();
    }
    return this;
  }
}

export class ComputedInstance<Value> extends SignalInstance<Value>
  implements ReadonlySignal<Value> {
  #compute: (previous: Value | undefined) => Value;
  #explicit: Set<ReadonlySignal<unknown>>;
  #dependencies = new Set<ReadonlySignal<unknown>>();
  #target = new EventTarget();

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
    this.#explicit = new Set(dependencies);
    this.#target.addEventListener("signal", () => this.refresh());
    this.#follow(initial.reads);
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
 * Where a `perInstance` call is running: `undefined` at the top of the
 * factory (instances span the document), `null` while building a detached
 * template (inert), or the instance root of the enclosing `perInstance`
 * (nested instances live inside it).
 */
let currentScope: Element | null | undefined;

/** @internal Runs `run` with `scope` as the current `perInstance` scope. */
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
 * @internal One `perInstance` call: a copy of its graph per instance root, created
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
  #key: string;
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
    return this.#key;
  }

  constructor(define: () => Graph, key: string) {
    this.#define = () => InstanceGroup.#named(define());
    this.#key = key;
    this.#scope = currentScope;
    this.template = withScope(null, this.#define);
  }

  /**
   * The graph of the instance enclosing `element`. An element whose `tt-link`
   * names this group (`<key>=<link id>`) belongs to that linked instance
   * instead, shared by every element naming the same link wherever it sits,
   * so a control outside a component can drive one of its instances.
   */
  instanceFor(element: Element): Graph {
    const selector =
      `[tt-instance~="${this.#key}"], [tt-link*="${this.#key}="]`;
    let root = element?.closest?.(selector);
    while (root && !root.matches(`[tt-instance~="${this.#key}"]`)) {
      const link = this.#linkOf(root);
      if (link) return this.#linkedGraph(link, root);
      root = root.parentElement?.closest(selector) ?? null;
    }
    if (!root || (this.#scope && !this.#scope.contains(root))) {
      throw new Error(
        `Per-instance signals must be used inside an instance root: an element with tt-instance="${this.#key}" (the collection's \`instanceKey\`, or \`instanceKeyFor(name)\` for a named perInstance).`,
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
    const prefix = `${this.#key}=`;
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
          JSON.parse(seed)?.[this.#key] ?? {},
          (message) => console.error(message),
        );
      } catch {
        console.error("Ignoring malformed tt-seed:", seed);
      }
    }
    for (const [name, signal] of Object.entries(graph)) {
      // Nested per-instance signals are aggregated by their own group.
      if (!(signal instanceof SignalInstance)) continue;
      const target = new EventTarget();
      target.addEventListener("signal", () => {
        const aggregate = this.#aggregates.get(name);
        if (aggregate) aggregate.value = this.#values(name);
      });
      signal.subscribe(target);
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
          `Cannot seed '${name}': it is not a writable signal of this perInstance level.`,
        );
        continue;
      }
      (signal as SignalInstance<unknown>).value = value;
    }
  }

  aggregate(name: string): SignalInstance<unknown[]> {
    if (this.template[name] instanceof InstanceSignalHandle) {
      throw new TypeError(
        "`.all` is not available for a nested per-instance signal here: read it inside the enclosing perInstance, where it covers that instance.",
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

  /**
   * As a handler, acts on the instance enclosing the element. Read from a
   * handler (no event) it returns itself so `.forInstance()` and `.all` are reachable.
   */
  handleEvent(target: unknown, event?: Event | null): unknown {
    if (!event) return this;
    return this.forInstance(target as Element).handleEvent(target, event);
  }

  /** `signal.name.update`, on the instance enclosing the element. */
  update(target: unknown, event?: Event | null): void {
    this.forInstance(target as Element).update(target, event);
  }

  /** `signal.name.toggle`, on the instance enclosing the element. */
  toggle(target: unknown): void {
    this.forInstance(target as Element).toggle();
  }

  /** `signal.name.fire`, on the instance enclosing the element. */
  fire(target: unknown): void {
    (this.forInstance(target as Element) as unknown as TriggerInstance).fire();
  }

  /** @internal The signal a fresh instance defines under this name. */
  get templateSignal(): SignalInstance<unknown> | InstanceSignalHandle {
    return this.#group.template[this.#name];
  }
}

/**
 * @internal The actions a signal offers in JSX for its kind, as
 * `signal.name.<action>`: `fire` for triggers, `update` for writable
 * signals and `toggle` too for boolean ones. Read from a factory's
 * server-side (inert) run, where computeds are not `SignalInstance` itself.
 */
export function signalActions(signal: unknown): SignalAction[] {
  if (signal instanceof InstanceSignalHandle) {
    return signalActions(signal.templateSignal);
  }
  if (signal instanceof TriggerInstance) return ["fire"];
  if (signal?.constructor !== SignalInstance) return [];
  return typeof (signal as SignalInstance<unknown>).value === "boolean"
    ? ["update", "toggle"]
    : ["update"];
}

/**
 * The `perInstance` of the collection whose instance roots carry
 * `instanceKey` (named levels carry `<instanceKey>-<name>`).
 */
export function perInstanceFor(
  instanceKey: string,
): SignalTools["perInstance"] {
  return ((
    ...args: [define: () => Graph] | [name: string, define: () => Graph]
  ): Record<string, InstanceSignalHandle> => {
    const [name, define] = args.length === 2 ? args : [undefined, args[0]];
    if (currentScope !== undefined && !name) {
      throw new TypeError(
        'A nested perInstance needs a name, e.g. perInstance("layer", () => ...), so its roots can be told apart from its parent\'s.',
      );
    }
    const group = new InstanceGroup(
      define,
      name ? `${instanceKey}-${name}` : instanceKey,
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
  }) as unknown as SignalTools["perInstance"];
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
    perInstance: perInstanceFor(instanceKey),
    InstanceSignal: InstanceSignalHandle,
    shapeSignals,
  };
}

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };
