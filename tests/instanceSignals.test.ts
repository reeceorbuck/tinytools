import { assertEquals, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import { signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";

const key = "layers_test";
const root = `tt-instance="${key}"`;

/** Installs a linkedom document as the global one the signal runtime reads. */
function installDocument(body: string) {
  const window = parseHTML(`<html><body>${body}</body></html>`);
  Object.assign(globalThis, {
    document: window.document,
    MutationObserver: window.MutationObserver,
  });
  return (id: string) => window.document.getElementById(id)!;
}

function uninstallDocument() {
  const globals = globalThis as Record<string, unknown>;
  delete globals.document;
  delete globals.MutationObserver;
}

/** A layer collection: per-instance material/shade plus an aggregate. */
function layerGraph() {
  const { Signal, Computed, perInstance } = signalClasses(true, key);
  const layer = perInstance(() => {
    const material = new Signal<string>("bulk");
    const shade = new Signal<string>("A3");
    const description = new Computed(
      () => `${material.value} ${shade.value}`,
      [material, shade],
    );
    return { material, shade, description };
  });
  const summary = new Computed(
    () => layer.description.all.value.join("; "),
    [layer.description.all],
  );
  return { ...layer, summary };
}

const change = (value: string) =>
  ({
    type: "change",
    target: { value, dataset: {}, name: "" },
  }) as unknown as Event;

Deno.test("per-instance signals resolve to the enclosing instance root", () => {
  // Roots of another collection around and alongside these are ignored.
  const byId = installDocument(`
    <div tt-instance="notes_test">
      <fieldset id="one" ${root}><select id="a"></select></fieldset>
      <fieldset id="two" tt-instance="notes_test ${key}">
        <select id="b"></select>
      </fieldset>
      <select id="outside"></select>
    </div>`);
  try {
    const { material, description } = layerGraph();
    const a = byId("a");
    const b = byId("b");

    // Written through the handler path, as `onChange={signal.material}` does.
    material.for(a);
    (material as unknown as {
      handleEvent(target: unknown, event: Event): unknown;
    }).handleEvent(a, change("flow"));

    assertEquals(material.for(a).value, "flow");
    assertEquals(material.for(b).value, "bulk");
    // Computeds inside perInstance see only their own instance.
    assertEquals(description.for(a).value, "flow A3");
    assertEquals(description.for(b).value, "bulk A3");
    // The root itself belongs to its instance.
    assertEquals(material.for(byId("one")).value, "flow");

    assertThrows(
      () => material.for(byId("outside")),
      Error,
      "instance root",
    );
    // Instance signals have no single value.
    assertThrows(() => (material as unknown as { value: unknown }).value);
  } finally {
    uninstallDocument();
  }
});

Deno.test("`.all` aggregates every instance in document order", async () => {
  const byId = installDocument(`
    <div id="list">
      <fieldset id="one" ${root}><select id="a"></select></fieldset>
      <fieldset id="two" ${root}><select id="b"></select></fieldset>
    </div>`);
  try {
    const { shade, material, summary } = layerGraph();
    const updates: string[] = [];
    const target = new EventTarget();
    target.addEventListener("signal", () => updates.push(summary.value));
    summary.subscribe(target);

    // Roots already in the document count before anything touches them.
    assertEquals(summary.value, "bulk A3; bulk A3");
    assertEquals(material.all.value, ["bulk", "bulk"]);

    shade.for(byId("b")).value = "B1";
    assertEquals(summary.value, "bulk A3; bulk B1");

    // Added roots join in document order, wherever they are inserted.
    const list = byId("list");
    list.insertAdjacentHTML(
      "afterbegin",
      `<fieldset id="zero" ${root}><select id="z"></select></fieldset>`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(summary.value, "bulk A3; bulk A3; bulk B1");

    material.for(byId("z")).value = "flow";
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");

    // Removed roots drop out.
    byId("one").remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(summary.value, "flow A3; bulk B1");
    assertEquals(updates.at(-1), "flow A3; bulk B1");
  } finally {
    uninstallDocument();
  }
});

Deno.test("per-instance signals stay inert outside the browser runtime", () => {
  const { Signal, perInstance } = signalClasses(false);
  const { material } = perInstance(() => ({ material: new Signal("bulk") }));
  // Aggregates can be declared during server-side validation.
  void material.all;
  assertThrows(() => material.for({} as Element), Error, "client handlers");
});

Deno.test("Signals collections expose an instance root and evaluate instances", () => {
  const signals = new Signals(
    import.meta.url,
    ({ Signal, Computed, perInstance }) => {
      const layer = perInstance(() => ({ material: new Signal("bulk") }));
      const count = new Computed(
        () => layer.material.all.value.length,
        [layer.material.all],
      );
      return { ...layer, isolation: new Signal<string>("rdam"), count };
    },
  );
  assertEquals(signals.instanceKey.startsWith("instanceSignals_test_"), true);

  // A fresh instance's values, and no instances on the server.
  assertEquals(signals.evaluateUsingInitialValues(), {
    material: "bulk",
    isolation: "rdam",
    count: 0,
  });
  assertEquals(
    signals.evaluateUsingInitialValues({ isolation: "isolite" }).isolation,
    "isolite",
  );
  assertThrows(
    // @ts-expect-error per-instance signals are not inputs
    () => signals.evaluateUsingInitialValues({ material: "flow" }),
    TypeError,
  );
});

/** A note with its own isolation and layers, as the restorative note uses. */
function noteGraph() {
  const { Signal, Computed, perInstance } = signalClasses(true, key);
  return perInstance(() => {
    const isolation = new Signal<string>("cheekguard");
    const layer = perInstance("layer", () => {
      const material = new Signal<string>("bulk");
      // Inner instances can read their parent's signals.
      const label = new Computed(
        () => `${material.value} (${isolation.value})`,
        [material, isolation],
      );
      return { material, label };
    });
    const summary = new Computed(
      () => layer.label.all.value.join("; "),
      [layer.label.all],
    );
    return { isolation, ...layer, summary };
  });
}

Deno.test("nested perInstance scopes each level and `.all` to its parent", async () => {
  const layerRoot = `tt-instance="${key}-layer"`;
  const byId = installDocument(`
    <form id="noteA" ${root}>
      <select id="isoA"></select>
      <output id="sumA"></output>
      <div id="layersA">
        <fieldset ${layerRoot}><select id="a1"></select></fieldset>
      </div>
    </form>
    <form id="noteB" ${root}>
      <output id="sumB"></output>
      <fieldset ${layerRoot}><select id="b1"></select></fieldset>
      <fieldset ${layerRoot}><select id="b2"></select></fieldset>
    </form>`);
  try {
    const { isolation, material, label, summary } = noteGraph();
    const sumA = byId("sumA");
    const sumB = byId("sumB");
    assertEquals(summary.for(sumA).value, "bulk (cheekguard)");
    assertEquals(
      summary.for(sumB).value,
      "bulk (cheekguard); bulk (cheekguard)",
    );

    // Each note keeps its own isolation and layers.
    isolation.for(byId("isoA")).value = "rdam";
    material.for(byId("b2")).value = "flow";
    assertEquals(label.for(byId("a1")).value, "bulk (rdam)");
    assertEquals(summary.for(sumA).value, "bulk (rdam)");
    assertEquals(
      summary.for(sumB).value,
      "bulk (cheekguard); flow (cheekguard)",
    );

    // A layer added to one note joins only that note's summary.
    byId("layersA").insertAdjacentHTML(
      "beforeend",
      `<fieldset ${layerRoot}><select id="a2"></select></fieldset>`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(summary.for(sumA).value, "bulk (rdam); bulk (rdam)");
    assertEquals(
      summary.for(sumB).value,
      "bulk (cheekguard); flow (cheekguard)",
    );

    // Layer signals need a layer root; nested `.all` is read inside the note.
    assertThrows(() => material.for(byId("isoA")), Error, `${key}-layer`);
    assertThrows(() => material.all, TypeError, "nested");
  } finally {
    uninstallDocument();
  }
});

Deno.test("a nested perInstance must be named", () => {
  const { Signal, perInstance } = signalClasses(true, key);
  assertThrows(
    () =>
      perInstance(() => ({
        ...perInstance(() => ({ inner: new Signal(1) })),
      })),
    TypeError,
    "needs a name",
  );
});

Deno.test("instanceKeyFor only accepts the collection's perInstance names", () => {
  const notes = new Signals(
    import.meta.url,
    ({ Signal, perInstance }) => {
      const note = perInstance(() => {
        const layer = perInstance("layer", () => ({
          material: new Signal<string>("bulk"),
        }));
        const tooth = perInstance("tooth", () => ({
          surface: new Signal<string>("O"),
        }));
        return { isolation: new Signal<string>("rdam"), ...layer, ...tooth };
      });
      return { ...note };
    },
  );
  assertEquals(
    notes.instanceKeyFor("layer"),
    `${notes.instanceKey}-layer`,
  );
  notes.instanceKeyFor("tooth");
  // @ts-expect-error not a perInstance name in this collection
  void (() => notes.instanceKeyFor("layers"));

  const flat = new Signals(
    import.meta.url,
    ({ Signal, perInstance }) => ({
      ...perInstance(() => ({ count: new Signal<number>(0) })),
    }),
  );
  // @ts-expect-error no named perInstance in this collection
  void (() => flat.instanceKeyFor("count"));
});
