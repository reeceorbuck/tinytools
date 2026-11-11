import { assertEquals } from "@std/assert";
import { assertThrows } from "@std/assert";
import { signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";
import { signalTools } from "../handlers/signals.ts";
import { loadHandler } from "./helpers/loadHandler.ts";
import { recordingSubscribers, update } from "./helpers/signalRuntime.ts";

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

Deno.test("fn.signals.multiply multiplies by the element's value, which it needs", async () => {
  const multiply = await loadHandler("multiply");
  const { Signal } = signalClasses();
  const zoom = new Signal<number>(4);
  let value: string | null = null;
  const button = { localName: "button", getAttribute: () => value };
  assertThrows(
    () => multiply.call(button, new Event("click"), zoom),
    TypeError,
    "fn.signals.multiply uses the element's value, but <button> has none",
  );
  value = "0.5";
  multiply.call(button, new Event("click"), zoom, zoom);
  assertEquals(zoom.value, 1);
  value = "big";
  assertThrows(
    () => multiply.call(button, new Event("click"), zoom),
    TypeError,
    "'big' is not a number",
  );
  // A control's live value is read.
  multiply.call({ localName: "input", value: "3" }, new Event("input"), zoom);
  assertEquals(zoom.value, 3);
});

Deno.test("a trigger notifies on each fire() and has no value to set", () => {
  const { Trigger } = signalClasses();
  const addRow = new Trigger();
  let notifications = 0;
  (addRow as unknown as EventTarget).addEventListener(
    "signal",
    () => notifications++,
  );
  addRow.fire();
  addRow.fire();
  assertEquals(notifications, 2);
  assertThrows(
    () => ((addRow as { value: unknown }).value = 1),
    TypeError,
    "fire()",
  );
});

Deno.test("signals take their name from the input that writes them", () => {
  const { Signal } = signalClasses();
  const signal = new Signal<string | null>(null);
  update({ value: "typed", name: "field" }, signal);
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

Deno.test("a subscription sends changes only, and fires on request", () => {
  const subscribers = recordingSubscribers();
  try {
    const { Signal } = signalClasses();
    const signal = new Signal<number>(1);
    const { element, seen } = subscribers.subscriber();
    signal.subscribe(element);
    assertEquals(seen, []);
    signal.value = 2;
    assertEquals(seen, [2]);
    // Equal values still do not notify.
    signal.value = 2;
    assertEquals(seen, [2]);
    // `fireSelfSignal` asks each subscribed signal for its current value.
    element.dispatchEvent(new Event("tt-fire-signals"));
    assertEquals(seen, [2, 2]);
    signal.unsubscribe(element);
    element.dispatchEvent(new Event("tt-fire-signals"));
    signal.value = 3;
    assertEquals(seen, [2, 2]);
  } finally {
    subscribers.restore();
  }
});

Deno.test("fireSelfSignal sends every subscribed signal once", () => {
  const subscribers = recordingSubscribers();
  try {
    const { Signal, Computed } = signalClasses();
    const a = new Signal<string>("a");
    const b = new Signal<number>(1);
    const doubled = new Computed(() => b.value * 2);
    const unrelated = new Signal<string>("x");
    const { element, seen } = subscribers.subscriber();
    for (const signal of [a, doubled]) signal.subscribe(element);
    // Subscribing twice is one subscription.
    a.subscribe(element);
    element.dispatchEvent(new Event("tt-fire-signals"));
    assertEquals(seen, ["a", 2]);
    unrelated.value = "y";
    assertEquals(seen, ["a", 2]);
  } finally {
    subscribers.restore();
  }
});

/** An element with the given attributes and properties, recording writes. */
function boundElement(
  attributes: Record<string, string>,
  properties: Record<string, unknown> = {},
  localName = "input",
) {
  const values = new Map(Object.entries(attributes));
  const writes: string[] = [];
  const element = {
    localName,
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
    "tt-src-signal": "bundle.status",
    // The element's own handlers are not a binding.
    "tt-handler-signal": "bundle.setBound",
  }, { value: "", checked: false });
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    // A signals bundle registers its signals.
    global.handlers = {
      bundle: {
        status,
        expanded,
        done,
        setBound: () => {
          throw new Error("tt-handler-signal is not a binding");
        },
      },
    };
    // Only bindings of the event's signal are written; false is text for
    // attributes, an unchanged value is not rewritten, and null removes an
    // attribute and empties a value. `src` is written as an attribute.
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
      "src=open",
      "-data-status",
      "value:",
      "-src",
    ]);
  } finally {
    global.handlers = previous;
  }
});

Deno.test("setBound writes the value attribute of elements but input and textarea", async () => {
  const setBound = await loadHandler("setBound");
  const { Signal } = signalClasses();
  const choice = new Signal<string | null>("a");
  const { element, writes } = boundElement(
    { "tt-value-signal": "bundle.choice" },
    { value: "" },
    "option",
  );
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    global.handlers = { bundle: { choice } };
    setBound.call(element, { signal: choice });
    setBound.call(element, { signal: choice });
    // Removed for null, so an option falls back to its text.
    choice.value = null;
    setBound.call(element, { signal: choice });
    assertEquals(writes, ["value=a", "-value"]);
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
        query: {
          forInstance: (target: unknown) =>
            target === element ? instance : null,
        },
      },
    };
    setBound.call(element, { signal: other });
    setBound.call(element, { signal: instance });
    assertEquals(writes, ["value:milk"]);
  } finally {
    global.handlers = previous;
  }
});

Deno.test("setBound writes a select's value as its property", async () => {
  const setBound = await loadHandler("setBound");
  const { Signal } = signalClasses();
  const site = new Signal<string>("Left");
  const { element, writes } = boundElement(
    { "tt-value-signal": "bundle.site" },
    { value: "Right" },
    "select",
  );
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  try {
    global.handlers = { bundle: { site } };
    setBound.call(element, { signal: site });
    setBound.call(element, { signal: site });
    assertEquals(writes, ["value:Left"]);
  } finally {
    global.handlers = previous;
  }
});

Deno.test("checkSelected warns when a select shows another option than its signal holds", async () => {
  const checkSelected = await loadHandler("checkSelected");
  const { Signal } = signalClasses();
  const site = new Signal<string>("Left");
  const { element } = boundElement(
    { "tt-value-signal": "bundle.site" },
    { value: "Left", name: "site" },
    "select",
  );
  const global = globalThis as { handlers?: unknown };
  const previous = global.handlers;
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (message: unknown) => warnings.push(message);
  try {
    global.handlers = { bundle: { site } };
    checkSelected.call(element);
    assertEquals(warnings, []);
    element.value = "Right";
    checkSelected.call(element);
    assertEquals(warnings, [
      `<select name="site"> shows "Right" but signal site holds "Left": mark the option matching the signal's initial value as selected.`,
    ]);
  } finally {
    console.warn = warn;
    global.handlers = previous;
  }
});
