import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { processIncomingDataTools } from "../handlers/processIncomingData.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

void processIncomingDataTools;

Deno.test("processIncomingData tolerates non-update HTML when the page has no global modal", async () => {
  const processIncomingData = await loadHandler("processIncomingData");
  const { document } = parseHTML("<html><body><p>page</p></body></html>");
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  const events: unknown[] = [];
  const listener = (event: Event) => events.push((event as CustomEvent).detail);
  globalThis.addEventListener("incomingdata", listener);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    await processIncomingData(
      new Response("<p>Not an update</p>", {
        headers: { "Content-Type": "text/html" },
      }),
    );
    assertEquals(events, []);
    assertEquals(warnings.some((w) => w.includes("Non-update")), true);

    await processIncomingData(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    assertEquals(events, [{ type: "json", data: { ok: true } }]);
  } finally {
    console.warn = originalWarn;
    globalThis.removeEventListener("incomingdata", listener);
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
