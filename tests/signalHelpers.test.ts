import { assertEquals } from "@std/assert";
import { assertThrows } from "@std/assert";
import { signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";
import { signalTools } from "../handlers/signals.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

void signalTools;

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

Deno.test("a signal bound to another event counts it", () => {
  type Dispatching<Value> = {
    value: Value;
    subscribe(target: EventTarget): void;
    handleEvent(target: unknown, event: Event): unknown;
  };
  const { Signal } = signalClasses();
  const requests = new Signal<number>(0) as unknown as Dispatching<number>;
  let notifications = 0;
  const listener = new EventTarget();
  listener.addEventListener("signal", () => notifications++);
  requests.subscribe(listener);
  const click = { type: "click" } as Event;
  requests.handleEvent({}, click);
  requests.handleEvent({}, click);
  assertEquals([requests.value, notifications], [2, 2]);
  const text = new Signal<string>("a") as unknown as Dispatching<string>;
  assertThrows(() => text.handleEvent({}, click), TypeError, "counts");
});

Deno.test("a trigger fires on every event and on fire()", () => {
  type Dispatching = {
    value: unknown;
    fire(): void;
    subscribe(target: EventTarget): void;
    handleEvent(target: unknown, event: Event): unknown;
  };
  const { Trigger } = signalClasses();
  const addRow = new Trigger() as unknown as Dispatching;
  let notifications = 0;
  const listener = new EventTarget();
  listener.addEventListener("signal", () => notifications++);
  addRow.subscribe(listener);
  addRow.handleEvent({}, { type: "click" } as Event);
  // A change event fires it too, rather than reading the control's value.
  addRow.handleEvent(
    {},
    { type: "change", target: { value: "x" } } as unknown as Event,
  );
  addRow.fire();
  assertEquals(notifications, 3);
  assertThrows(() => (addRow.value = 1), TypeError, "fire()");
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
    target: { value: "typed", name: "field" },
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

Deno.test("a load subscription sends changes only, and fires on request", () => {
  const { Signal } = signalClasses();
  const signal = new Signal<number>(1);
  const target = new EventTarget();
  const seen: unknown[] = [];
  target.addEventListener("signal", (event) => {
    seen.push((event as Event & { signal: { value: unknown } }).signal.value);
  });
  const subscriber = signal as unknown as {
    handleEvent(target: unknown, event: Event): unknown;
  };
  subscriber.handleEvent(target, new Event("load"));
  assertEquals(seen, []);
  signal.value = 2;
  assertEquals(seen, [2]);
  // Equal values still do not notify.
  signal.value = 2;
  assertEquals(seen, [2]);
  // `fireSelfSignal` asks each subscribed signal for its current value.
  target.dispatchEvent(new Event("tt-fire-signals"));
  assertEquals(seen, [2, 2]);
  signal.unsubscribe(target);
  target.dispatchEvent(new Event("tt-fire-signals"));
  signal.value = 3;
  assertEquals(seen, [2, 2]);
});

Deno.test("fireSelfSignal sends every subscribed signal once", () => {
  const { Signal, Computed } = signalClasses();
  const a = new Signal<string>("a");
  const b = new Signal<number>(1);
  const doubled = new Computed(() => b.value * 2);
  const unrelated = new Signal<string>("x");
  const target = new EventTarget();
  const seen: unknown[] = [];
  target.addEventListener("signal", (event) => {
    seen.push((event as Event & { signal: { value: unknown } }).signal.value);
  });
  for (const signal of [a, doubled]) signal.subscribe(target);
  // Subscribing twice is one subscription.
  a.subscribe(target);
  target.dispatchEvent(new Event("tt-fire-signals"));
  assertEquals(seen, ["a", 2]);
  unrelated.value = "y";
  assertEquals(seen, ["a", 2]);
});

Deno.test("setValue writes any signal, only on a change", async () => {
  const setValue = await loadHandler("setValue");
  const { Signal } = signalClasses();
  const count = new Signal<number>(2);
  const writes: string[] = [];
  const element = {
    current: "",
    get value() {
      return this.current;
    },
    set value(value: string) {
      writes.push(value);
      this.current = value;
    },
  };
  setValue.call(element, { signal: count });
  setValue.call(element, { signal: count });
  assertEquals(writes, ["2"]);
});

/** An element with the given attributes and properties, recording writes. */
function boundElement(
  attributes: Record<string, string>,
  properties: Record<string, unknown> = {},
) {
  const values = new Map(Object.entries(attributes));
  const writes: string[] = [];
  const element = {
    get attributes() {
      return [...values].map(([name, value]) => ({ name, value }));
    },
    getAttribute: (name: string) => values.get(name) ?? null,
    setAttribute(name: string, value: string) {
      writes.push(`${name}=${value}`);
      values.set(name, value);
    },
    removeAttribute(name: string) {
      writes.push(`-${name}`);
      values.delete(name);
    },
  };
  for (const [name, initial] of Object.entries(properties)) {
    let current = initial;
    Object.defineProperty(element, name, {
      get: () => current,
      set(value) {
        writes.push(`${name}:${value}`);
        current = value;
      },
    });
  }
  return {
    element: element as typeof element & Record<string, unknown>,
    writes,
  };
}

Deno.test("setBound writes each binding of the event's signal, only on a change", async () => {
  const setBound = await loadHandler("setBound");
  const { Signal } = signalClasses();
  const status = new Signal<string | null>("open");
  const expanded = new Signal<boolean>(false);
  const done = new Signal<boolean>(true);
  const { element, writes } = boundElement({
    "tt-data-status-signal": "bundle.status",
    "tt-aria-expanded-signal": "bundle.expanded",
    "tt-value-signal": "bundle.status",
    "tt-checked-signal": "bundle.done",
    // The element's own handlers are not a binding.
    "tt-handler-signal": "bundle.setBound",
  }, { value: "", checked: false });
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    // Run without an event, a signal's handler returns the signal.
    global.handlers = {
      bundle: {
        status: () => status,
        expanded: () => expanded,
        done: () => done,
        setBound: () => {
          throw new Error("tt-handler-signal is not a binding");
        },
      },
    };
    // Only bindings of the event's signal are written; false is text for
    // attributes, an unchanged value is not rewritten, and null removes an
    // attribute and empties a value.
    setBound.call(element, { signal: expanded });
    setBound.call(element, { signal: expanded });
    setBound.call(element, { signal: done });
    setBound.call(element, { signal: status });
    status.value = null;
    setBound.call(element, { signal: status });
    assertEquals(writes, [
      "aria-expanded=false",
      "checked:true",
      "data-status=open",
      "value:open",
      "-data-status",
      "value:",
    ]);
  } finally {
    global.handlers = previous;
  }
});

Deno.test("setBound resolves a per-instance signal for the element", async () => {
  const setBound = await loadHandler("setBound");
  const { Signal } = signalClasses();
  const instance = new Signal<string>("milk");
  const other = new Signal<string>("tea");
  const { element, writes } = boundElement(
    { "tt-value-signal": "bundle.query" },
    { value: "" },
  );
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    global.handlers = {
      bundle: {
        query: () => ({
          forInstance: (target: unknown) =>
            target === element ? instance : null,
        }),
      },
    };
    setBound.call(element, { signal: other });
    setBound.call(element, { signal: instance });
    assertEquals(writes, ["value:milk"]);
  } finally {
    global.handlers = previous;
  }
});
