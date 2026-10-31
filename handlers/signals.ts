import { type Handlers, type Signal, type SignalValue, tiny } from "../mod.ts";

/** The event a `tiny.Signals` signal dispatches to its subscribers. */
export interface SignalEvent extends Event {
  /** The signal that changed; read its new value from `signal.value`. */
  signal: Signal<SignalValue>;
}

/** An upgraded custom element (a lifecycle element) receiving signal events. */
export interface SignalElement extends HTMLElement {
  /** Aborted when the element disconnects, ending its subscriptions. */
  abortController: AbortController;
}

/**
 * The setters the JSX runtime binds for a signal given as an element property
 * or attribute, or placed as a child. Apart from `signalTools`, so a page
 * only loads the helpers it binds.
 */
export const signalBindingTools = new tiny.Handlers(import.meta.url, {
  /**
   * Writes the signal into each property or attribute the element was given
   * it as (`<input value={signal.query} />`, `<div data-status={signal.status}>`),
   * found by their `tt-<name>-signal` attributes; ones bound to other signals
   * are left alone. `value` takes the value as a string, `data-*` and
   * `aria-*` attributes as their text (removed for `null`), and other
   * properties (`checked`, `hidden`, ...) as a boolean. A property is only
   * written when it differs, so typing is not interrupted by its own signal
   * coming back. The JSX runtime binds this for you.
   */
  setBound: function (this: Element, event: SignalEvent): void {
    const element = this as unknown as Record<string, unknown>;
    const { value } = event.signal;
    for (const { name, value: bound } of [...this.attributes]) {
      const property =
        /^tt-(value|checked|selected|disabled|hidden|(?:data|aria)-.+)-signal$/
          .exec(name)?.[1];
      if (!property) continue;
      const dot = bound.indexOf(".");
      // Run without an event, a signal's handler returns the signal; a
      // per-instance one then resolves the instance enclosing this element.
      const signal = (globalThis as {
        handlers?: Record<
          string,
          Record<string, (this: Element) => Record<string, unknown>>
        >;
      }).handlers?.[bound.slice(0, dot)]?.[bound.slice(dot + 1)]?.call(this);
      const forInstance = signal?.forInstance as
        | ((element: Element) => unknown)
        | undefined;
      if ((forInstance?.call(signal, this) ?? signal) !== event.signal) {
        continue;
      }
      if (/^(data|aria)-/.test(property)) {
        const text = value?.toString() ?? null;
        if (this.getAttribute(property) === text) continue;
        if (text === null) this.removeAttribute(property);
        else this.setAttribute(property, text);
        continue;
      }
      const next = property === "value"
        ? value?.toString() ?? ""
        : Boolean(value);
      if (element[property] !== next) element[property] = next;
    }
  },
  /** Writes the signal value as the element's text (`<signal-text>`). */
  setTextContent: function (this: Element, event: SignalEvent): void {
    this.textContent = `${event.signal.value}`;
  },
});

/**
 * Helpers for consuming `tiny.Signals` values in the browser. Bind them to the
 * `onSignal` event of an element subscribed with `onConnect={signal.name}`.
 */
export const signalTools: Handlers<{
  /**
   * Runs the element's `onSignal` handler once for each signal it has
   * subscribed to so far, with that signal's current value. Subscribing alone
   * only hears later changes, so list this after the signals in `onConnect`
   * (`onConnect={[signal.filter, fn.fireSelfSignal]}`) when the element must
   * catch up with a value that may have changed before it connected.
   */
  fireSelfSignal(this: HTMLElement): void;
  /** Writes the signal value as the element's text. */
  setTextContent(this: Element, event: SignalEvent): void;
  /** Writes the signal value into an input, when it differs. */
  setValue(this: HTMLInputElement, event: SignalEvent): void;
  /** Sets the custom property `--<signal name>` to the signal value. */
  setCssProperty(this: HTMLElement, event: SignalEvent): void;
}> = new tiny.Handlers(import.meta.url, {
  fireSelfSignal: function (this: HTMLElement): void {
    this.dispatchEvent(new Event("tt-fire-signals"));
  },
  setTextContent: function (this: Element, event: SignalEvent): void {
    this.textContent = `${event.signal.value}`;
  },
  setValue: function (this: HTMLInputElement, event: SignalEvent): void {
    const next = event.signal.value?.toString() ?? "";
    if (this.value !== next) this.value = next;
  },
  setCssProperty: function (this: HTMLElement, event: SignalEvent): void {
    const { name, value } = event.signal;
    if (!name) {
      console.error("setCssProperty requires the signal to have a name.");
      return;
    }
    this.style.setProperty(`--${name}`, value?.toString() ?? "");
  },
});
