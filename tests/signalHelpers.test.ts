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

Deno.test("setValue writes only its bound signal, and only on a change", async () => {
  const setValue = await loadHandler("setValue");
  const { Signal } = signalClasses();
  const query = new Signal<string>("tea");
  const other = new Signal<number>(2);
  const writes: string[] = [];
  const element = {
    current: "tea",
    get value() {
      return this.current;
    },
    set value(value: string) {
      writes.push(value);
      this.current = value;
    },
    bound: null as string | null,
    getAttribute(name: string) {
      return name === "tt-value-signal" ? this.bound : null;
    },
  };
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    // Unbound, any signal is written.
    setValue.call(element, { signal: other });
    assertEquals(writes, ["2"]);
    // Bound, a signal's handler run without an event returns the signal.
    element.bound = "bundle.query";
    global.handlers = {
      bundle: {
        // As the collection's bundle defines it.
        query(this: unknown, event?: Event) {
          return (query as unknown as {
            handleEvent(target: unknown, event?: Event): unknown;
          }).handleEvent(this, event);
        },
      },
    };
    query.value = "coffee";
    setValue.call(element, { signal: other });
    setValue.call(element, { signal: query });
    // The same value is not written again.
    setValue.call(element, { signal: query });
    assertEquals(writes, ["2", "coffee"]);
    // A per-instance signal resolves the instance enclosing the element.
    const instance = new Signal<string>("milk");
    global.handlers = {
      bundle: {
        query: () => ({
          forInstance: (target: unknown) =>
            target === element ? instance : null,
        }),
      },
    };
    setValue.call(element, { signal: query });
    setValue.call(element, { signal: instance });
    assertEquals(writes, ["2", "coffee", "milk"]);
  } finally {
    global.handlers = previous;
  }
});

Deno.test("setChecked writes only its bound signal, and only on a change", async () => {
  const setChecked = await loadHandler("setChecked");
  const { Signal } = signalClasses();
  const done = new Signal<boolean>(false);
  const count = new Signal<number>(3);
  const writes: boolean[] = [];
  const element = {
    current: false,
    get checked() {
      return this.current;
    },
    set checked(checked: boolean) {
      writes.push(checked);
      this.current = checked;
    },
    bound: null as string | null,
    getAttribute(name: string) {
      return name === "tt-checked-signal" ? this.bound : null;
    },
  };
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    // Unbound, any signal is written as truthy or not.
    setChecked.call(element, { signal: count });
    assertEquals(writes, [true]);
    element.bound = "bundle.done";
    global.handlers = { bundle: { done: () => done } };
    // Bound, other signals are ignored and an unchanged value is not written.
    count.value = 0;
    setChecked.call(element, { signal: count });
    done.value = true;
    setChecked.call(element, { signal: done });
    done.value = false;
    setChecked.call(element, { signal: done });
    assertEquals(writes, [true, false]);
  } finally {
    global.handlers = previous;
  }
});

Deno.test("setSelected writes only its bound signal, and only on a change", async () => {
  const setSelected = await loadHandler("setSelected");
  const { Signal } = signalClasses();
  const isDental = new Signal<boolean>(false);
  const other = new Signal<string>("x");
  const writes: boolean[] = [];
  const element = {
    current: false,
    get selected() {
      return this.current;
    },
    set selected(selected: boolean) {
      writes.push(selected);
      this.current = selected;
    },
    getAttribute(name: string) {
      return name === "tt-selected-signal" ? "bundle.isDental" : null;
    },
  };
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    global.handlers = { bundle: { isDental: () => isDental } };
    setSelected.call(element, { signal: other });
    setSelected.call(element, { signal: isDental });
    isDental.value = true;
    setSelected.call(element, { signal: isDental });
    setSelected.call(element, { signal: isDental });
    assertEquals(writes, [true]);
  } finally {
    global.handlers = previous;
  }
});
