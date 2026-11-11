import { signalActionTools, signalSyncTools } from "../../handlers/signals.ts";

type Mutator = (this: unknown, event: unknown, ...signals: unknown[]) => void;
type MutatorName =
  | "subscribe"
  | "update"
  | "toggle"
  | "add"
  | "multiply"
  | "fire";

await Promise.all([
  signalSyncTools.ensureDefined(),
  signalActionTools.ensureDefined(),
]);

/** The `fn.signals` handlers, as their bundles define them. */
export function signalMutators(): Record<MutatorName, Mutator> {
  return {
    ...signalSyncTools.run,
    ...signalActionTools.run,
  } as unknown as Record<MutatorName, Mutator>;
}

/** Writes `control`'s value into each signal, as `fn.signals.update` does. */
export function update(control: unknown, ...signals: unknown[]): void {
  signalMutators().update.call(control, { target: control }, ...signals);
}

/** A stand-in for a lifecycle element subscribing to signals. */
export type Subscriber = Element & { abortController: AbortController };

/**
 * Stand-ins for elements subscribing to signals. `subscribe` hands each
 * change to `tiny.runHandler(element, event)`, stubbed here to record the
 * values each element is sent; `restore` puts back the previous `tiny`.
 */
export function recordingSubscribers(): {
  subscriber(): { element: Subscriber; seen: unknown[] };
  restore(): void;
} {
  const globals = globalThis as { tiny?: unknown };
  const previous = globals.tiny;
  const received = new WeakMap<object, unknown[]>();
  globals.tiny = {
    runHandler(target: object, event: Event) {
      received.get(target)?.push(
        (event as Event & { signal: { value: unknown } }).signal.value,
      );
    },
  };
  return {
    subscriber() {
      const element = Object.assign(new EventTarget(), {
        abortController: new AbortController(),
      });
      const seen: unknown[] = [];
      received.set(element, seen);
      return { element: element as unknown as Subscriber, seen };
    },
    restore() {
      if (previous === undefined) delete globals.tiny;
      else globals.tiny = previous;
    },
  };
}
