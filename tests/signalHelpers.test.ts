import { assertEquals } from "@std/assert";
import { signalClasses } from "../signals.ts";
import { signalTools } from "../handlers/signals.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

void signalTools;

Deno.test("effect runs for named and unnamed signals until aborted", async () => {
  const effect = await loadHandler("effect");
  const { Signal, Computed } = signalClasses();
  const named = new Signal<number>(1);
  named.name = "count";
  const unnamed = new Signal<string>("a");
  const doubled = new Computed(() => Number(named.value) * 2, [named]);

  let runs = 0;
  const controller = new AbortController();
  effect(() => runs++, [named, unnamed], controller);

  named.value = 2;
  assertEquals(runs, 1);
  assertEquals(doubled.value, 4);
  unnamed.value = "b";
  assertEquals(runs, 2);
  // Equal values do not notify.
  unnamed.value = "b";
  assertEquals(runs, 2);

  controller.abort();
  named.value = 3;
  assertEquals(runs, 2);
});

Deno.test("setCssProperty writes the signal's named custom property", async () => {
  const setCssProperty = await loadHandler("setCssProperty");
  const { Signal } = signalClasses();
  const properties = new Map<string, string>();
  const element = {
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
  };
  const signal = new Signal<number>(0.5);
  signal.name = "contrast-adjust";
  setCssProperty.call(element, { signal });
  assertEquals(properties.get("--contrast-adjust"), "0.5");

  const unnamed = new Signal<number>(1);
  setCssProperty.call(element, { signal: unnamed });
  assertEquals(properties.size, 1);
});

Deno.test("signals take their name from the input that writes them", () => {
  const { Signal } = signalClasses();
  const signal = new Signal<string | null>(null) as unknown as {
    value: string | null;
    name?: string;
    handleEvent(target: unknown, event?: Event | null): unknown;
  };
  signal.handleEvent(null, {
    type: "input",
    target: { value: "typed", dataset: { bindName: "" }, name: "field" },
  } as unknown as Event);
  assertEquals(signal.value, "typed");
  assertEquals(signal.name, "field");
});
