import { type Signal, type SignalValue, tiny } from "../mod.ts";

type EffectFn = () => void;

/** The event a `tiny.Signals` signal dispatches to its subscribers. */
export interface SignalEvent extends Event {
  signal: Signal<SignalValue>;
  /** True for the event delivered when the element subscribed on load. */
  initial?: boolean;
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
  /** Runs `callback` whenever any of `dependencies` changes, until the controller aborts. */
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
  /** Writes the signal value as the element's text. */
  setTextContent: function (this: SignalElement, event: SignalEvent): void {
    this.textContent = `${event.signal.value}`;
  },
  /** Writes the signal value into an input. */
  setValue: function (this: HTMLInputElement, event: SignalEvent): void {
    this.value = event.signal.value?.toString() ?? "";
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
