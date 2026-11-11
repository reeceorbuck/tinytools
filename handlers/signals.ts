import type {
  Handlers,
  ReadonlySignal,
  Signal,
  SignalValue,
  Trigger,
} from "../mod.ts";
import { sourcedCollections } from "../clientTools.ts";

const sourced = sourcedCollections(import.meta.url);

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
export const signalBindingTools = new sourced.Handlers({
  /**
   * Writes the signal into each property or attribute the element was given
   * it as (`<input value={signal.query} />`, `<div data-status={signal.status}>`),
   * found by their `tt-<name>-signal` attributes; ones bound to other signals
   * are left alone. An input's, select's or textarea's `value` takes the
   * value as a string; `src`, `data-*`, `aria-*` and any other element's `value`
   * attribute as their text (removed for `null`), and other
   * properties (`checked`, `hidden`, ...) as a boolean. A property is only
   * written when it differs, so typing is not interrupted by its own signal
   * coming back. The JSX runtime binds this for you.
   */
  setBound: function (this: Element, event: SignalEvent): void {
    const element = this as unknown as Record<string, unknown>;
    const { value } = event.signal;
    for (const { name, value: bound } of [...this.attributes]) {
      const property =
        /^tt-(value|checked|selected|disabled|hidden|src|(?:data|aria)-.+)-signal$/
          .exec(name)?.[1];
      if (!property) continue;
      const dot = bound.indexOf(".");
      // A signals bundle registers its signals; a per-instance one then
      // resolves the instance enclosing this element.
      const signal = (globalThis as {
        handlers?: Record<string, Record<string, Record<string, unknown>>>;
      }).handlers?.[bound.slice(0, dot)]?.[bound.slice(dot + 1)];
      const forInstance = signal?.forInstance as
        | ((element: Element) => unknown)
        | undefined;
      if ((forInstance?.call(signal, this) ?? signal) !== event.signal) {
        continue;
      }
      if (
        /^(?:(?:data|aria)-|src$)/.test(property) ||
        (property === "value" &&
          !/^(?:input|select|textarea)$/.test(this.localName))
      ) {
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
  /**
   * Warns, on connect, when a select given a signal as its value
   * (`<select value={signal.site}>`) shows another option than the signal
   * holds. A select renders no value, so its initial option is the one
   * marked `selected`, which should match the signal's initial value.
   */
  checkSelected: function (this: HTMLSelectElement): void {
    const bound = this.getAttribute("tt-value-signal");
    if (!bound) return;
    const dot = bound.indexOf(".");
    const signal = (globalThis as {
      handlers?: Record<string, Record<string, Record<string, unknown>>>;
    }).handlers?.[bound.slice(0, dot)]?.[bound.slice(dot + 1)];
    const forInstance = signal?.forInstance as
      | ((element: Element) => unknown)
      | undefined;
    const own = (forInstance?.call(signal, this) ?? signal) as
      | { value?: unknown }
      | undefined;
    if (!own) return;
    const expected = own.value?.toString() ?? "";
    if (this.value !== expected) {
      console.warn(
        `<select${
          this.name ? ` name="${this.name}"` : ""
        }> shows "${this.value}" but signal ${
          bound.slice(dot + 1)
        } holds "${expected}": mark the option matching the signal's initial value as selected.`,
        this,
      );
    }
  },
});

/**
 * `fn.signals.subscribe` and `fn.signals.update`, the pair a control bound
 * to a signal uses: `<input value={signal.query}
 * onInput={fn.signals.update(signal.query)} />` subscribes to the signal and
 * writes it. Like every `fn.signals` handler, each takes the signals its
 * reference was given, a per-instance one as the instance enclosing the
 * element.
 */
export const signalSyncTools = new sourced.Handlers({
  /** Runs the element's `onSignal` handlers on each later change of every signal. */
  subscribe: function (
    this: Element,
    _event: Event,
    ...signals: ReadonlySignal<unknown>[]
  ): void {
    for (const signal of signals) signal.subscribe(this);
  },
  /**
   * Writes the control's value into each signal, in the signal's shape: a
   * checkbox writes `checked` to a boolean signal and otherwise the checked
   * values of its group (the inputs sharing its form and name), a multiple
   * select its selected values, and a numeric signal reads a number. The
   * signal takes the control's name when it has one.
   */
  update: function (this: Element, event: Event, ...signals: Signal[]): void {
    const control = event.target as
      & HTMLInputElement
      & Partial<Pick<HTMLSelectElement, "selectedOptions">>;
    for (const signal of signals) {
      const current = signal.value;
      let value: SignalValue;
      if (control.type === "checkbox" && typeof current === "boolean") {
        value = !!control.checked;
      } else if (control.type === "checkbox") {
        const named = control.name
          ? control.form?.elements.namedItem(control.name)
          : null;
        const group = typeof RadioNodeList !== "undefined" &&
            named instanceof RadioNodeList
          ? Array.from(named) as HTMLInputElement[]
          : [control];
        value = group.filter((input) => input.checked).map((input) =>
          input.value
        );
      } else if (control.multiple && control.selectedOptions) {
        value = Array.from(control.selectedOptions, (option) => option.value);
      } else if (typeof current === "number") {
        value = control.value === "" ? NaN : Number(control.value);
      } else value = control.value;
      signal.value = value;
      if (control.name) signal.name = control.name;
    }
  },
});

/**
 * `fn.signals.toggle`, `add`, `multiply` and `fire`, apart from
 * `signalSyncTools` so only pages that bind one of them load them.
 */
export const signalActionTools = new sourced.Handlers({
  /** Flips each boolean signal. */
  toggle: function (
    this: Element,
    _event: Event,
    ...signals: Signal<boolean>[]
  ): void {
    for (const signal of signals) signal.value = !signal.value;
  },
  /**
   * Adds the element's value to each signal: a control's live one, or the
   * `value` attribute of any other element, which it must have. A negative
   * value subtracts.
   */
  add: function (
    this: Element,
    _event: Event,
    ...signals: Signal<number>[]
  ): void {
    const text = /^(input|select|textarea)$/.test(this.localName)
      ? (this as HTMLInputElement).value
      : this.getAttribute("value");
    const amount = text?.trim() ? Number(text) : NaN;
    if (Number.isNaN(amount)) {
      throw new TypeError(
        `fn.signals.add uses the element's value, but ${
          text?.trim()
            ? `<${this.localName}>'s value '${text}' is not a number.`
            : `<${this.localName}> has none: give it one, such as value={1}.`
        }`,
      );
    }
    for (const signal of signals) signal.value += amount;
  },
  /** Multiplies each signal by the element's value, read as `add` reads it. */
  multiply: function (
    this: Element,
    _event: Event,
    ...signals: Signal<number>[]
  ): void {
    const text = /^(input|select|textarea)$/.test(this.localName)
      ? (this as HTMLInputElement).value
      : this.getAttribute("value");
    const factor = text?.trim() ? Number(text) : NaN;
    if (Number.isNaN(factor)) {
      throw new TypeError(
        `fn.signals.multiply uses the element's value, but ${
          text?.trim()
            ? `<${this.localName}>'s value '${text}' is not a number.`
            : `<${this.localName}> has none: give it one, such as value={2}.`
        }`,
      );
    }
    for (const signal of signals) signal.value *= factor;
  },
  /** Fires each trigger. */
  fire: function (this: Element, _event: Event, ...signals: Trigger[]): void {
    for (const signal of signals) signal.fire();
  },
});

/**
 * Helpers for consuming `tiny.Signals` values in the browser. Bind them to the
 * `onSignal` event of an element subscribed with
 * `onConnect={fn.signals.subscribe(signal.name)}`.
 */
export const signalTools: Handlers<{
  /**
   * Runs the element's `onSignal` handler once for each signal it has
   * subscribed to so far, with that signal's current value. Subscribing alone
   * only hears later changes, so list this after the signals in `onConnect`
   * (`onConnect={[fn.signals.subscribe(signal.filter), fn.fireSelfSignal]}`) when the element must
   * catch up with a value that may have changed before it connected.
   */
  fireSelfSignal(this: HTMLElement): void;
  /** Writes the signal value as the element's text. */
  setTextContent(this: Element, event: SignalEvent): void;
  /** Sets the custom property `--<signal name>` to the signal value. */
  setCssProperty(this: HTMLElement, event: SignalEvent): void;
}> = new sourced.Handlers({
  fireSelfSignal: function (this: HTMLElement): void {
    this.dispatchEvent(new Event("tt-fire-signals"));
  },
  setTextContent: function (this: Element, event: SignalEvent): void {
    this.textContent = `${event.signal.value}`;
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
