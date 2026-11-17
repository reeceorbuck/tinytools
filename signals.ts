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
  /**
   * The signal of the instance enclosing `element`: inside a root of the
   * collection, that root's copy; anywhere else this one, the page's.
   */
  forInstance(element: Element): ReadonlySignal<Value>;
}

/** Type-only marker telling writable signals apart from computed ones. */
declare const writableSignal: unique symbol;

/** A writable signal: setting `value` notifies its subscribers. */
export interface Signal<Value = SignalValue> extends ReadonlySignal<Value> {
  /** The current value; setting a different one notifies subscribers. */
  value: Value;
  /** As on `ReadonlySignal`: the copy is writable too. */
  forInstance(element: Element): Signal<Value>;
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
  /** As on `ReadonlySignal`: the copy is a trigger too. */
  forInstance(element: Element): Trigger;
  /** Type-only: marks the signal as a trigger. */
  readonly [triggerSignal]?: true;
}

/**
 * What a signal of type `S` holds, as the `fn.signals` handlers check it:
 * every signal `reads` its value, a writable one also `writes` it and a
 * trigger `fires`. `fn.signals.add` takes signals that write a number,
 * `toggle` ones that write a boolean.
 */
export type SignalHolding<S> = typeof triggerSignal extends keyof S
  ? { readonly reads: unknown; readonly fires: true }
  : S extends ReadonlySignal<infer Value>
    ? typeof writableSignal extends keyof S
      ? { readonly reads: Value; readonly writes: Value }
    : { readonly reads: Value }
  : never;

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
}

/** What a Signals factory returns: its signals, by name. */
export type SignalDefinitions = Record<string, ReadonlySignal<unknown>>;

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

/**
 * The values `evaluateUsingInitialValues` accepts: any of the collection's
 * writable signals, except the `Persisted` ones, which only the browser
 * knows.
 */
export type SignalInputs<
  Definitions extends SignalDefinitions,
  Persisted extends PropertyKey = never,
> = {
  [
    Name in keyof Definitions as Name extends Persisted ? never
      : typeof writableSignal extends keyof Definitions[Name] ? Name
      : never
  ]?: Definitions[Name] extends ReadonlySignal<infer Value> ? Value : never;
};

/**
 * Where a persisted signal keeps its value in the browser, under `key`:
 * `{ local: "app.savedStops" }` in `localStorage`, `{ session: key }` in
 * `sessionStorage`. The key is spelled out rather than derived because it
 * outlives the code: renaming a signal or moving its file must not lose what
 * browsers have stored. With `sync`, a change another tab stores is written
 * to this tab's signal too.
 */
export type SignalStorage =
  | {
    readonly local: string;
    readonly sync?: boolean;
    readonly session?: never;
  }
  | { readonly session: string; readonly local?: never; readonly sync?: never };

/**
 * A persisted signal as the browser bundle is told of it (see
 * `persistSignals`).
 */
export type PersistedSignal = {
  readonly area: "local" | "session";
  readonly key: string;
  readonly sync?: boolean;
};

/** The value of every signal in a collection, as `evaluateUsingInitialValues` returns them. */
export type SignalValues<Definitions extends SignalDefinitions> = {
  [Name in keyof Definitions]: Definitions[Name] extends
    ReadonlySignal<infer Value> ? Value
    : never;
};

/**
 * The values a root can start its copy of a collection with: its writable
 * signals, persisted ones included. Seeds travel as JSON.
 */
export type InstanceSeed<Definitions extends SignalDefinitions> = {
  [
    Name in keyof Definitions as typeof writableSignal extends
      keyof Definitions[Name] ? Name : never
  ]?: Definitions[Name] extends ReadonlySignal<infer Value> ? Value : never;
};

/**
 * The values `evaluateUsingInitialValues` can start a root's copy from, as
 * the server renders a seeded root: the same as `InstanceSeed`.
 */
export type EvaluationSeed<Definitions extends SignalDefinitions> =
  InstanceSeed<Definitions>;

// ============================================================================
// Runtime
//
// The classes below are the signal runtime itself, used as they are on the
// server and shipped to the browser as source (see `signalModules.ts`), split
// into modules by feature so a page only loads what its collections use:
// `Signal` and `signalsFrom` (always), `Computed`, `Trigger`, and the
// per-root copies of a collection. Each shipped function may therefore only use the DOM, `tiny`
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

/**
 * The element the instance being built or recomputed belongs to: its root,
 * or for a linked instance the member it was made for. `undefined` outside
 * every instance (a page-wide signal) and `null` in a detached build (a
 * collection's template copy, or the server's seeded run). A collection's
 * signal read here resolves relative to it: `.value` to its copy in the root
 * enclosing it, `.all` to the copies inside it.
 */
let currentRoot: Element | null | undefined;

/** @internal Runs `run` with `root` as the current instance's element. */
export function inRoot<Result>(
  root: Element | null | undefined,
  run: () => Result,
): Result {
  const previous = currentRoot;
  currentRoot = root;
  try {
    return run();
  } finally {
    currentRoot = previous;
  }
}

/** @internal The current instance's element (see `currentRoot`). */
export function rootNow(): Element | null | undefined {
  return currentRoot;
}

/**
 * @internal Hears each read, from inside an instance, of a collection's own
 * signals (see `SignalInstance.rootable`): the server learns from them how
 * collections a component roots nest. Unset in the browser.
 */
let rootReads:
  | ((rootable: Rootable, how: "value" | "all") => void)
  | undefined;

/** @internal Sets the `rootReads` hook, returning the one it replaces. */
export function hearRootReads(
  hook: typeof rootReads,
): typeof rootReads {
  const previous = rootReads;
  rootReads = hook;
  return previous;
}

/**
 * How a collection's own (page-wide) signal finds its copy in the instance a
 * root gives: the collection's `instanceKey`, the signal's name, the group
 * of instances, made the first time a root needs one, and a detached copy,
 * for the values a fresh one starts with.
 */
export type Rootable = {
  readonly key: string;
  readonly name: string;
  group(): InstanceGroup;
  template(): Record<string, SignalInstance<unknown>>;
};

/**
 * @internal Makes the group of a collection's copies. The per-root runtime,
 * `tt-instance`, installs it when it loads, so a page none of whose
 * collections is rooted never loads it.
 */
let rootGroups:
  | ((
    define: () => Record<string, SignalInstance<unknown>>,
    key: string,
  ) => InstanceGroup)
  | undefined;

/** The import of the per-root runtime, once one has started. */
let loadingRoots: Promise<unknown> | undefined;

/** @internal Installs how a collection's copies are grouped (see `rootGroups`). */
export function installRoots(make: typeof rootGroups): void {
  rootGroups = make;
}

/**
 * Makes `page`, the signals a collection exports, its page-wide instance:
 * inside a root of the collection (an element whose `tt-instance` holds
 * `key`, or whose `tt-link` names it) each stands for that root's own copy,
 * which `define` builds the first time something inside the root resolves
 * it. `load` imports the per-root runtime those copies need: it starts at
 * once on a page that already has a root, and a handler running inside one
 * waits for it (see `runHandler`); nothing changes for a page with no root.
 */
export function rootable(
  page: Record<string, unknown>,
  define: () => Record<string, SignalInstance<unknown>>,
  key: string,
  load?: () => Promise<unknown>,
): void {
  if (load) {
    // The page's runtime: a classic script's global binding, not a property
    // of `globalThis`, which a test stands in for.
    const host = (typeof tiny === "undefined"
      ? (globalThis as { tiny?: unknown }).tiny
      : tiny) as { waitForRoots?: unknown } | undefined;
    const start = () => loadingRoots ??= load();
    // What a handler running at `target` waits for (see `runHandler`).
    if (host) {
      host.waitForRoots ??= (
        target: Element,
        type: string,
        signals: boolean,
      ) => {
        if (rootGroups || !target.closest?.("[tt-instance], [tt-link]")) {
          return;
        }
        const loading = start();
        return signals || /^(connect|signal|parsed|load)$/.test(type)
          ? loading
          : undefined;
      };
    }
    if (
      !rootGroups &&
      (globalThis as { document?: Document }).document?.querySelector(
        "[tt-instance], [tt-link]",
      )
    ) start();
  }
  let group: InstanceGroup | undefined;
  let template: Record<string, SignalInstance<unknown>> | undefined;
  const rooted = {
    key,
    group: () => {
      if (!rootGroups) {
        throw new Error(
          `'${key}' was read in a root before the per-root runtime loaded: read it from a handler there.`,
        );
      }
      return group ??= rootGroups(define, key);
    },
    template: () => template ??= inRoot(null, define),
  };
  for (const [name, signal] of Object.entries(page)) {
    if (signal instanceof SignalInstance) {
      signal.rootable = { ...rooted, name };
    }
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

  /**
   * @internal Set on the signals a collection exports (`rootable`): those
   * are its page-wide instance, which stands for each root's own copy inside
   * that root. Unset on the signals of an instance.
   */
  rootable?: Rootable;

  constructor(initialValue: Value = null as Value) {
    super();
    this.#value = initialValue;
  }

  get value(): Value {
    if (this.rootable && currentRoot !== undefined) {
      rootReads?.(this.rootable, "value");
      const own = this.#forCurrentRoot();
      if (own !== this) return own.value;
    }
    tracking?.add(this as SignalInstance<unknown>);
    return this.#value;
  }

  set value(value: Value) {
    const own = this.#forCurrentRoot();
    if (own !== this) own.#write(value);
    else this.#write(value);
  }

  #write(value: Value): void {
    if (sameValue(this.#value, value)) return;
    this.#value = value;
    this.dispatchEvent(this.createEvent());
  }

  /** This signal's copy in the instance being built or recomputed, if any. */
  #forCurrentRoot(): SignalInstance<Value> {
    return currentRoot && this.rootable ? this.forInstance(currentRoot) : this;
  }

  /**
   * The signal of the instance enclosing `element`: for a collection's own
   * signal inside one of its roots (an element whose `tt-instance` holds the
   * collection's `instanceKey`, or whose `tt-link` names it), that root's
   * copy, made the first time; anywhere else this signal, the page's.
   */
  forInstance(element: Element): SignalInstance<Value> {
    const rootable = this.rootable;
    if (!rootable) return this;
    const { key } = rootable;
    if (!element?.closest?.(`[tt-instance~="${key}"], [tt-link*="${key}="]`)) {
      return this;
    }
    return rootable.group().instanceFor(element)[
      rootable.name
    ] as SignalInstance<Value>;
  }

  /**
   * The signal a computed built in `root`'s instance depends on when listing
   * this one (see `currentRoot`): the copy in the root enclosing it, or
   * outside every root, this one.
   */
  resolveIn(root: Element | null | undefined): SignalInstance<Value> {
    if (this.rootable && root !== undefined) {
      rootReads?.(this.rootable, "value");
    }
    return root ? this.forInstance(root) : this;
  }

  /**
   * Every root's copy's value, in document order; read from inside an
   * instance of another collection (see `currentRoot`), only the copies
   * whose roots sit inside it. The page's own value is not among them.
   */
  get all(): ReadonlySignal<Value[]> {
    const rootable = this.rootable;
    if (!rootable) {
      throw new TypeError("`.all` is on a collection's signals, not a copy's.");
    }
    if (currentRoot !== undefined) rootReads?.(rootable, "all");
    return rootable.group().aggregateWithin(
      rootable.name,
      currentRoot,
    ) as ReadonlySignal<Value[]>;
  }

  /** The value of a fresh copy, as a root starts with. */
  get initialValue(): Value {
    const rootable = this.rootable;
    if (!rootable) return this.#value;
    return untracked(() =>
      (rootable.template()[rootable.name] as SignalInstance<Value>).value
    );
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
 * Keeps writable signals in browser storage: each starts from its stored
 * value, when there is one of the same type as its initial value, and every
 * change is stored, a change back to the initial value by removing the key.
 * Runs once in a collection's bundle, after its signals are built and before
 * anything subscribes, so subscribers that need the restored value at once
 * fire themselves (`fn.fireSelfSignal`). Storage that throws (blocked, full,
 * private mode) leaves the signal working as an unpersisted one.
 */
export function persistSignals(
  signals: Record<string, unknown>,
  persisted: Record<string, PersistedSignal>,
): void {
  const isValue = (value: unknown): boolean =>
    value === null || typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"));
  for (const [name, { area, key, sync }] of Object.entries(persisted)) {
    const signal = signals[name] as SignalInstance<unknown>;
    const initial = signal.value;
    const initialText = JSON.stringify(initial);
    // A stored value must have the initial value's type; `null` says nothing.
    const fits = (value: unknown) =>
      isValue(value) &&
      (initial === null ||
        (Array.isArray(initial)
          ? Array.isArray(value)
          : value !== null && !Array.isArray(value) &&
            typeof value === typeof initial));
    let storage: Storage;
    try {
      storage = area === "session" ? sessionStorage : localStorage;
    } catch {
      continue;
    }
    let restoring = false;
    const restore = (text: string | null) => {
      let value = initial;
      if (text !== null) {
        try {
          value = JSON.parse(text);
        } catch {
          return;
        }
        if (!fits(value)) return;
      }
      restoring = true;
      try {
        signal.value = value;
      } finally {
        restoring = false;
      }
    };
    try {
      const stored = storage.getItem(key);
      if (stored !== null) restore(stored);
    } catch {
      // Unreadable storage: start from the initial value.
    }
    signal.addEventListener("signal", () => {
      if (restoring) return;
      const text = JSON.stringify(signal.value);
      try {
        if (text === initialText) storage.removeItem(key);
        else storage.setItem(key, text);
      } catch {
        // Full or blocked: the value is simply not kept.
      }
    });
    if (sync) {
      globalThis.addEventListener("storage", (event: StorageEvent) => {
        if (event.storageArea !== storage) return;
        // A `null` key means the whole storage was cleared.
        if (event.key === key) restore(event.newValue);
        else if (event.key === null) restore(null);
      });
    }
  }
}

/**
 * The signals of a shape, as `tiny.Signals(tools, define)` returns it: each
 * function a computed whose `this` is the shape's own signals, each initial
 * value a writable signal, and anything already built kept. Computeds run
 * when built, so each is built when first read: one may read a sibling
 * declared after it. Anything but a plain object is returned as it is. The
 * classes are passed in so the server can check a factory with inert
 * computeds.
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

  override forInstance(element: Element): TriggerInstance {
    return super.forInstance(element) as TriggerInstance;
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
  /**
   * The instance it was built in (see `currentRoot`), current again on each
   * recompute, so another collection's signals it reads keep
   * resolving to the same instances.
   */
  #root: Element | null | undefined;

  /**
   * With `initialValue`, `compute` waits for a change of `dependencies`. A
   * signal of another collection among `dependencies` stands
   * for its instance enclosing this one.
   */
  constructor(
    compute: (previous: Value | undefined) => Value,
    dependencies: readonly ReadonlySignal<unknown>[] = [],
    ...initialValue: [] | [Value]
  ) {
    const root = rootNow();
    const explicit = dependencies.map((dependency) => {
      const resolve = (dependency as { resolveIn?: (root: unknown) => unknown })
        .resolveIn;
      return typeof resolve === "function"
        ? resolve.call(dependency, root)
        : dependency;
    });
    const initial = initialValue.length
      ? { value: initialValue[0] as Value, reads: new Set<never>() }
      : track(() => compute(undefined));
    super(initial.value);
    this.#compute = compute;
    this.#root = root;
    this.#explicit = explicit as unknown as readonly EventTarget[];
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
    const { value, reads } = inRoot(
      this.#root,
      () => track(() => this.#compute(super.value)),
    );
    this.#follow(reads);
    // Written as built: a page-wide computed refreshed from inside an
    // instance is still the page's.
    inRoot(this.#root, () => {
      super.value = value;
    });
  }

  override get value(): Value {
    return super.value;
  }

  override set value(_value: Value) {
    throw new TypeError("Computed signals are read-only.");
  }
}

type Graph = Record<string, SignalInstance<unknown>>;

/**
 * @internal A collection's copies: one graph per root, created the first
 * time something inside the root resolves one of its signals (an
 * `onConnect` or `onChange` reference), its roots anywhere in the document.
 * An instance is parked when its root's `abortController` aborts, which
 * lifecycle elements provide: it leaves `.all` and is held only as long as
 * the root element itself lives, so the same element re-inserted later
 * resumes its values while a removed one is collected with its graph.
 * Nothing observes the document.
 */
export class InstanceGroup {
  #define: () => Graph;
  /** The `tt-instance` key of the collection's roots: its `instanceKey`. */
  readonly key: string;
  #instances = new Map<Element, Graph>();
  /** Instances shared by linked elements, by link id. */
  #linked = new Map<string, { graph: Graph; members: Set<Element> }>();
  /** Graphs of roots whose controller aborted, kept while the element lives. */
  #parked = new WeakMap<Element, Graph>();
  /** `.all` of each signal, recomputed whenever an instance changes. */
  #aggregates = new Map<string, SignalInstance<unknown[]>>();
  /**
   * `.all` of each signal over only the instances inside one element, as an
   * instance of another collection reads it. Held weakly: the computeds
   * reading one keep it, and it goes with the instance they belong to.
   */
  #within: {
    name: string;
    element: WeakRef<Element>;
    aggregate: WeakRef<SignalInstance<unknown[]>>;
  }[] = [];
  /** A detached copy listing the signal names and server-side values. */
  readonly template: Graph;

  /**
   * `define` builds one copy of the collection's signals; `instanceKey` is
   * what its roots carry (see `rootSignals`).
   */
  constructor(define: () => Graph, instanceKey: string) {
    this.#define = () => InstanceGroup.#named(define());
    this.key = instanceKey;
    this.template = inRoot(null, this.#define);
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
    if (!root) {
      throw new Error(
        `No root of the collection encloses this element: an element with tt-instance="${key}" (the collection's \`instanceKey\`).`,
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
      linked = { graph: this.#create(null, member), members: new Set() };
      this.#linked.set(link, linked);
    }
    if (!linked.members.has(member)) {
      linked.members.add(member);
      this.#refreshAggregates();
    }
    return linked.graph;
  }

  /**
   * A new instance for `root`, or with no root for a linked one, made for
   * `member`: either is what another collection's signals read
   * in it resolve from.
   */
  #create(root: Element | null, member: Element | null = root): Graph {
    const graph = inRoot(member, this.#define);
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
      signal.addEventListener("signal", () => {
        const aggregate = this.#aggregates.get(name);
        if (aggregate) aggregate.value = this.#values(name);
        this.#refreshWithin(name);
      });
    }
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
        report(`Cannot seed '${name}': it is not a writable signal.`);
        continue;
      }
      (signal as SignalInstance<unknown>).value = value;
    }
  }

  aggregate(name: string): SignalInstance<unknown[]> {
    let aggregate = this.#aggregates.get(name);
    if (!aggregate) {
      aggregate = new SignalInstance(this.#values(name));
      this.#aggregates.set(name, aggregate);
    }
    return aggregate;
  }

  /**
   * `.all` as an instance of another collection reads it, built for
   * `within`, the element that instance belongs to (see `currentRoot`): only
   * the instances whose roots sit inside it, so a parent sees its own
   * children. Anywhere else it is `aggregate(name)`.
   */
  aggregateWithin(
    name: string,
    within: Element | null | undefined,
  ): SignalInstance<unknown[]> {
    if (!within) return this.aggregate(name);
    for (const entry of this.#within) {
      const aggregate = entry.aggregate.deref();
      if (
        aggregate && entry.name === name && entry.element.deref() === within
      ) return aggregate;
    }
    const aggregate = new SignalInstance(this.#values(name, within));
    this.#within.push({
      name,
      element: new WeakRef(within),
      aggregate: new WeakRef(aggregate),
    });
    return aggregate;
  }

  /** Recomputes the `.all` held for elements (see `aggregateWithin`). */
  #refreshWithin(name?: string): void {
    this.#within = this.#within.filter((entry) => {
      const element = entry.element.deref();
      const aggregate = entry.aggregate.deref();
      if (!element || !aggregate) return false;
      if (name === undefined || entry.name === name) {
        aggregate.value = this.#values(entry.name, element);
      }
      return true;
    });
  }

  /**
   * Every connected instance's value in document order, or with `within`,
   * only those whose root (or first member) sits inside it. Instances notify
   * the aggregate themselves (see `#create`), so the reads are not tracked:
   * removed instances must not keep a computed reading `.all` alive.
   */
  #values(name: string, within?: Element): unknown[] {
    return untracked(() => {
      // A linked instance counts once, at its first connected member.
      const placed: [Element, Graph][] = [...this.#instances]
        .filter(([root]) => root.isConnected);
      for (const { graph, members } of this.#linked.values()) {
        const first = [...members].filter((member) => member.isConnected)
          .sort(InstanceGroup.#documentOrder)[0];
        if (first) placed.push([first, graph]);
      }
      return placed.filter(([root]) => !within || within.contains(root))
        .sort(([a], [b]) => InstanceGroup.#documentOrder(a, b))
        .map(([, graph]) => graph[name].value);
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
    this.#refreshWithin();
  }
}

/** @internal What the per-root runtime installs when it loads. */
export function groupRoots(define: () => Graph, key: string): InstanceGroup {
  return new InstanceGroup(define, key);
}

/**
 * `rootable` on the server, where the per-root runtime is always there: a
 * collection's signals as its bundle makes them in the browser.
 */
export function rootSignals(
  page: Record<string, unknown>,
  define: () => Graph,
  key: string,
): void {
  installRoots(groupRoots);
  rootable(page, define, key);
}

/** What a signal is, for which `fn.signals` handlers take it. */
export type SignalKind = "trigger" | "writable" | "computed";

/**
 * @internal The kind of `signal`. Read from a factory's server-side (inert)
 * run, where computeds are not `SignalInstance` itself.
 */
export function signalKind(signal: unknown): SignalKind {
  if (signal instanceof TriggerInstance) return "trigger";
  return signal?.constructor === SignalInstance ? "writable" : "computed";
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

/** The toolkit a collection's factory receives, and what shapes build with. */
export type InternalSignalTools = SignalTools & {
  shapeSignals: typeof shapeSignals;
};

/**
 * The signal toolkit for one collection, as a factory receives it. With
 * `runtime` false computeds stay inert, for checking a factory without
 * running it.
 */
export function signalClasses(runtime = true): InternalSignalTools {
  return {
    Signal: SignalInstance as unknown as SignalTools["Signal"],
    Trigger: TriggerInstance,
    Computed:
      (runtime ? ComputedInstance : InertComputed) as unknown as SignalTools[
        "Computed"
      ],
    signalsFrom: signalsFrom as SignalTools["signalsFrom"],
    shapeSignals,
  };
}

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };
