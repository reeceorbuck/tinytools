import { Handlers } from "../clientTools.ts";

/**
 * Scoped value broadcasting over `CommandEvent`s, for elements that must
 * react to a sibling input inside the same container (for example each row
 * of a repeated fieldset). Unlike `tiny.Signals`, which are page-wide, the
 * broadcast reaches only `[data-signal-tracking~="<input name>"]` elements
 * inside the given container.
 *
 * @example
 * ```tsx
 * <select name="row-1-type" onChange={fn.broadcastSibling} />
 * <select data-signal-tracking="row-1-type" onCommand={fn.applyType} />
 * ```
 * where `broadcastSibling` calls `fn.broadcastInputValue(this, this.closest("fieldset"))`
 * and `applyType` reads `fn.readBroadcastValue(event).get("row-1-type")`.
 */
export const commandSignalTools = new Handlers(import.meta.url, {
  /** The `name → value` pair carried by a broadcast command event. */
  readBroadcastValue: function (event: CommandEvent): Map<string, string> {
    const values = new Map<string, string>();
    // Handlers ship as source, so the command name is repeated rather than shared.
    if (event.command !== "--signal") {
      console.error(
        "readBroadcastValue received a non-broadcast command:",
        event,
      );
      return values;
    }
    const source = event.source as HTMLSelectElement | HTMLInputElement | null;
    if (!source?.name) {
      console.error("readBroadcastValue: the command source has no name.");
      return values;
    }
    values.set(source.name, source.value || "");
    return values;
  },

  /**
   * Dispatches a broadcast command from `source` to every element tracking
   * its name within `container` (defaults to the source's form, then the
   * whole document).
   */
  broadcastInputValue: function (
    source: HTMLSelectElement | HTMLInputElement,
    container?: HTMLElement | null,
  ): void {
    const root = container || source.form || globalThis.document;
    const selector = `[data-signal-tracking~="${source.name}"]`;
    const targets = Array.from(root.querySelectorAll(selector));
    if (root instanceof Element && root.matches(selector)) {
      targets.unshift(root);
    }
    for (const target of targets) {
      target.dispatchEvent(
        new CommandEvent("command", { source, command: "--signal" }),
      );
    }
  },
});
