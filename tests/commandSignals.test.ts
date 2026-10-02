import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { commandSignalTools } from "../handlers/commandSignals.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

void commandSignalTools;

Deno.test("command signals broadcast an input's value to tracking elements in its container", async () => {
  const { document, Element, Event: DomEvent } = parseHTML(
    `<html><body><form>
      <fieldset id="row">
        <input name="row-type" value="infl">
        <select id="site" data-signal-tracking="row-type"></select>
      </fieldset>
      <select id="elsewhere" data-signal-tracking="row-type"></select>
      <select id="other" data-signal-tracking="other-name"></select>
    </form></body></html>`,
  );
  /** Browsers' CommandEvent, which Deno and linkedom lack; built on linkedom's Event so it can be dispatched there. */
  class FakeCommandEvent extends DomEvent {
    readonly source: Element | null;
    readonly command: string;
    constructor(
      type: string,
      init: { source?: Element | null; command?: string } = {},
    ) {
      super(type, { bubbles: true });
      this.source = init.source ?? null;
      this.command = init.command ?? "";
    }
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (
    const [name, value] of Object.entries({
      document,
      Element,
      CommandEvent: FakeCommandEvent,
    })
  ) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  try {
    const broadcastInputValue = await loadHandler("broadcastInputValue");
    const readBroadcastValue = await loadHandler("readBroadcastValue");

    const received: Record<string, string[]> = {};
    for (const id of ["site", "elsewhere", "other"]) {
      document.getElementById(id)!.addEventListener("command", (event) => {
        const values = readBroadcastValue(event) as Map<string, string>;
        received[id] = [...values.entries()].flat();
      });
    }

    const source = document.querySelector("input")!;
    broadcastInputValue(source, document.getElementById("row"));
    assertEquals(received, { site: ["row-type", "infl"] });

    // Without a container the whole form is searched.
    broadcastInputValue(source);
    assertEquals(received.elsewhere, ["row-type", "infl"]);
    assertEquals("other" in received, false);

    // Reading a non-broadcast command yields nothing.
    const stray = new FakeCommandEvent("command", {
      source,
      command: "--something-else",
    });
    assertEquals((readBroadcastValue(stray) as Map<string, string>).size, 0);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
