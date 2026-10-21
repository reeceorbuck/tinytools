import { type Signal, type SignalValue, tiny } from "../mod.ts";

type EffectFn = () => void;

/** The event a `tiny.Signals` signal dispatches to its subscribers. */
export interface SignalEvent extends Event {
  signal: Signal<SignalValue>;
}

/** An upgraded custom element (see `UpgradeCustomElement`) receiving signal events. */
export interface SignalElement extends HTMLElement {
  abortController: AbortController;
}

/**
 * Writes the signal value into the element's `property`: as a string for
 * `value`, as a boolean otherwise. When the element was given a signal as that
 * property (`<input value={signal.query} />`), its `tt-<property>-signal`
 * names that signal and any other signal the element subscribes to is
 * ignored. The property is only written when it differs, so typing is not
 * interrupted by its own signal coming back.
 *
 * Listed in `signalTools` so the setters below can call it: each handler is
 * a function of the same bundle module.
 */
function setBoundProperty(
  this: Element,
  event: SignalEvent,
  property: string,
): void {
  const bound = this.getAttribute(`tt-${property}-signal`);
  if (bound) {
    const dot = bound.indexOf(".");
    const handler = (globalThis as {
      handlers?: Record<string, Record<string, (this: Element) => unknown>>;
    }).handlers?.[bound.slice(0, dot)]?.[bound.slice(dot + 1)];
    // Run without an event, a signal's handler returns the signal; a
    // per-instance one then resolves the instance enclosing this element.
    const signal = handler?.call(this) as
      | { forInstance?(element: Element): unknown }
      | undefined;
    const own = typeof signal?.forInstance === "function"
      ? signal.forInstance(this)
      : signal;
    if (own !== event.signal) return;
  }
  const { value } = event.signal;
  const next = property === "value" ? value?.toString() ?? "" : Boolean(value);
  const element = this as unknown as Record<string, unknown>;
  if (element[property] !== next) element[property] = next;
}

/**
 * Helpers for consuming `tiny.Signals` values in the browser. Bind them to the
 * `onSignal` event of an element subscribed with `onConnect={signal.name}`.
 */
export const signalTools = new tiny.Handlers(import.meta.url, {
  setBoundProperty,
  /**
   * Runs the element's `onSignal` handler once for each signal it has
   * subscribed to so far, with that signal's current value. Subscribing alone
   * only hears later changes, so list this after the signals in `onConnect`
   * (`onConnect={[signal.filter, fn.fireSelfSignal]}`) when the element must
   * catch up with a value that may have changed before it connected.
   */
  fireSelfSignal: function (this: HTMLElement): void {
    this.dispatchEvent(new Event("tt-fire-signals"));
  },
  /** Writes the signal value as the element's text. */
  setTextContent: function (this: SignalElement, event: SignalEvent): void {
    this.textContent = `${event.signal.value}`;
  },
  /** Writes the signal value into an input (see `setBoundProperty`). */
  setValue: function (this: HTMLInputElement, event: SignalEvent): void {
    setBoundProperty.call(this, event, "value");
  },
  /** Checks a checkbox or radio while the signal value is truthy. */
  setChecked: function (this: HTMLInputElement, event: SignalEvent): void {
    setBoundProperty.call(this, event, "checked");
  },
  /** Selects an option while the signal value is truthy. */
  setSelected: function (this: HTMLOptionElement, event: SignalEvent): void {
    setBoundProperty.call(this, event, "selected");
  },
  /** Disables a form control while the signal value is truthy. */
  setDisabled: function (this: HTMLInputElement, event: SignalEvent): void {
    setBoundProperty.call(this, event, "disabled");
  },
  /** Hides the element while the signal value is truthy. */
  setHidden: function (this: HTMLElement, event: SignalEvent): void {
    setBoundProperty.call(this, event, "hidden");
  },
  /** Sets the custom property `--<signal name>` to the signal value. */
  setCssProperty: function (this: HTMLElement, event: SignalEvent): void {
    const { name, value } = event.signal;
    if (!name) {
      console.error("setCssProperty requires the signal to have a name.");
      return;
    }
    this.style.setProperty(`--${name}`, value?.toString() ?? "");
  },
});

export const outdatedSignalTools = new tiny.Handlers(import.meta.url, {
  /** Runs `callback` whenever any of `dependencies` changes, until the controller aborts. */
  // I think this is no longer required since html attributes can now directly bind to signal values.
  effect: function (
    callback: EffectFn,
    dependencies: Signal<SignalValue>[],
    abortController: AbortController,
  ): void {
    const target = new EventTarget();
    for (const signal of dependencies) {
      signal.subscribe(target);
    }
    target.addEventListener("signal", callback, {
      signal: abortController.signal,
    });
  },
});
