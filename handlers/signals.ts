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
 * Helpers for consuming `tiny.Signals` values in the browser. Bind them to the
 * `onSignal` event of an element subscribed with `onConnect={signal.name}`.
 */
export const signalTools = new tiny.Handlers(import.meta.url, {
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
  /**
   * Writes the signal value into an input. On an element given a signal as
   * `value` (`<input value={signal.query} />`), whose `tt-value-signal` names
   * it, any other signal the element subscribes to is ignored. The value is
   * only written when it differs, so typing is not interrupted by its own
   * signal coming back.
   */
  setValue: function (this: HTMLInputElement, event: SignalEvent): void {
    const bound = this.getAttribute("tt-value-signal");
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
    const value = event.signal.value?.toString() ?? "";
    if (this.value !== value) this.value = value;
  },
  /**
   * Checks a checkbox or radio when the signal value is truthy. On an element
   * given a signal as `checked` (`<input type="checkbox"
   * checked={signal.done} />`), whose `tt-checked-signal` names it, any other
   * signal the element subscribes to is ignored, as with `setValue`.
   */
  setChecked: function (this: HTMLInputElement, event: SignalEvent): void {
    const bound = this.getAttribute("tt-checked-signal");
    if (bound) {
      const dot = bound.indexOf(".");
      const handler = (globalThis as {
        handlers?: Record<string, Record<string, (this: Element) => unknown>>;
      }).handlers?.[bound.slice(0, dot)]?.[bound.slice(dot + 1)];
      // Resolved as setValue resolves its signal.
      const signal = handler?.call(this) as
        | { forInstance?(element: Element): unknown }
        | undefined;
      const own = typeof signal?.forInstance === "function"
        ? signal.forInstance(this)
        : signal;
      if (own !== event.signal) return;
    }
    const checked = Boolean(event.signal.value);
    if (this.checked !== checked) this.checked = checked;
  },
  /**
   * Selects an option when the signal value is truthy. On an option given a
   * signal as `selected` (`<option selected={signal.isDental}>`), whose
   * `tt-selected-signal` names it, any other signal the option subscribes to
   * is ignored, as with `setValue`.
   */
  setSelected: function (this: HTMLOptionElement, event: SignalEvent): void {
    const bound = this.getAttribute("tt-selected-signal");
    if (bound) {
      const dot = bound.indexOf(".");
      const handler = (globalThis as {
        handlers?: Record<string, Record<string, (this: Element) => unknown>>;
      }).handlers?.[bound.slice(0, dot)]?.[bound.slice(dot + 1)];
      // Resolved as setValue resolves its signal.
      const signal = handler?.call(this) as
        | { forInstance?(element: Element): unknown }
        | undefined;
      const own = typeof signal?.forInstance === "function"
        ? signal.forInstance(this)
        : signal;
      if (own !== event.signal) return;
    }
    const selected = Boolean(event.signal.value);
    if (this.selected !== selected) this.selected = selected;
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
