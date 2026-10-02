import { assertEquals } from "@std/assert";
import { assertThrows } from "@std/assert";
import { signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";
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

Deno.test("evaluateUsingInitialValues computes a collection's values on the server", () => {
  const signals = new Signals(import.meta.url, ({ Signal, Computed }) => {
    const price = new Signal<number>(10);
    const quantity = new Signal<number>(1);
    const total = new Computed(() => price.value * quantity.value, [
      price,
      quantity,
    ]);
    return {
      price,
      quantity,
      total,
      label: new Computed(() => `Total: ${total.value}`, [total]),
    };
  });

  // Signals left out keep their initial values.
  assertEquals(signals.evaluateUsingInitialValues(), {
    price: 10,
    quantity: 1,
    total: 10,
    label: "Total: 10",
  });
  const { total, label }: { total: number; label: string } = signals
    .evaluateUsingInitialValues({ quantity: 3 });
  assertEquals([total, label], [30, "Total: 30"]);
  // Each call starts from a fresh graph.
  assertEquals(signals.evaluateUsingInitialValues({ price: 2 }).total, 2);

  // Only writable signals are inputs.
  assertThrows(
    // @ts-expect-error computed signals are not accepted
    () => signals.evaluateUsingInitialValues({ total: 5 }),
    TypeError,
  );
  assertThrows(
    // @ts-expect-error unknown names are not accepted
    () => signals.evaluateUsingInitialValues({ missing: 5 }),
    TypeError,
  );
});

Deno.test("a signal without an initial value must allow null", () => {
  const { Signal } = signalClasses();
  assertEquals(new Signal().value, null);
  assertEquals(new Signal<string | null>().value, null);
  const text: string = new Signal<string>("a").value;
  assertEquals(text, "a");
  // @ts-expect-error a string signal needs an initial value
  new Signal<string>();
});
