import { type Signal, type SignalValue, tiny } from "../mod.ts";

type EffectFn = () => void;
export interface SignalEvent extends Event {
  signal: Signal<SignalValue>;
}

export interface SignalElement extends HTMLElement {
  abortController: AbortController;
}

// When I left TODO: signals should have a name assigned if the setting element has a name
// plus an override if they have a data-bind-name attribute.
// However, we should only use onSignal as an event name and not as a signal name
// We casn identify signals in handlers rather than using a name
// Also, are all the methods still used now?

export const signalTools = new tiny.Handlers(import.meta.url, {
  effect: function (
    callback: EffectFn,
    deps: Signal<SignalValue>[],
    abortController: AbortController,
  ) {
    const target = new EventTarget();
    deps.forEach((signal) => {
      signal.subscribe(target);
      target.addEventListener(
        `signal${signal.name ? signal.name.toLowerCase() : ""}`,
        callback,
        {
          signal: abortController.signal,
        },
      );
    });
  },
  setTextContent: function (
    this: SignalElement,
    event: SignalEvent,
  ) {
    this.textContent = `${event.signal.value}`;
  },
  setValue: function (this: HTMLInputElement, event: SignalEvent) {
    this.value = event.signal.value?.toString() ?? "";
  },
  setCssProperty: function (this: HTMLElement, event: SignalEvent) {
    const { name, value } = event.signal;
    this.style.setProperty(`--${name}`, value?.toString() ?? "");
  },
});
