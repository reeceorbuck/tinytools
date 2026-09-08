import { tiny } from "../mod.ts";

export const signalTools = new tiny.Handlers(import.meta.url, {
  useSignal: function (e: CommandEvent) {
    const returnValue = new Map<string, string>();
    if (e.command !== "--signal") {
      console.error("useSignal with non-signal command: ", e);
      return returnValue;
    }
    const source = e.source as HTMLSelectElement | HTMLInputElement | null;
    if (!source || !source.name) {
      console.error("No source or name found for useSignal");
      return returnValue;
    }
    returnValue.set(source.name, source.value || "");
    return returnValue;
  },

  sendSignal: function (
    source: HTMLSelectElement | HTMLInputElement,
    container?: HTMLElement | null,
  ) {
    if (!container) {
      console.warn(
        "Firing signal without container, using source form instead, or entire document, source: ",
        source,
      );
    }
    const root = container || source.form || globalThis.document;
    const selector = `[data-signal-tracking~="${source.name}"]`;
    const signalTargets: Element[] = Array.from(
      root.querySelectorAll(selector),
    );
    if (
      root instanceof Element &&
      root.matches(selector) &&
      !signalTargets.includes(root)
    ) {
      signalTargets.unshift(root);
    }
    console.log(
      `Found ${signalTargets.length} signal targets for name ${source.name} in container:`,
      signalTargets,
    );
    signalTargets.forEach((target) => {
      target.dispatchEvent(
        new CommandEvent("command", {
          source: source,
          command: "--signal",
        }),
      );
    });
  },
});

export const { useSignal, sendSignal } = signalTools.getFunctionReferences;