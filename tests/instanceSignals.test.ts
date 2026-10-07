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

Deno.test("`.all` aggregates every resolved instance in document order", () => {
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

    // Nothing scans the document: a root counts once something inside it
    // resolves a signal, as its onLoad / onChange references do.
    assertEquals(summary.value, "");
    shade.for(byId("b")).value = "B1";
    assertEquals(summary.value, "bulk B1");
    material.for(byId("a"));
    assertEquals(summary.value, "bulk A3; bulk B1");
    assertEquals(material.all.value, ["bulk", "bulk"]);

    // Later roots join in document order, wherever they are inserted.
    byId("list").insertAdjacentHTML(
      "afterbegin",
      `<fieldset id="zero" ${root}><select id="z"></select></fieldset>`,
    );
    material.for(byId("z")).value = "flow";
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");

    // An upgraded root (one with an abortController) leaves when it aborts.
    const controller = new AbortController();
    const upgraded = byId("list").ownerDocument.createElement("fieldset");
    upgraded.setAttribute("tt-instance", key);
    upgraded.innerHTML = `<select id="u"></select>`;
    Object.assign(upgraded, { abortController: controller });
    byId("list").append(upgraded);
    material.for(byId("u")).value = "glass";
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1; glass A3");
    upgraded.remove();
    controller.abort();
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");
    assertEquals(updates.at(-1), "flow A3; bulk A3; bulk B1");

    // Without an abort, a removed root is left out of values but not dropped.
    byId("one").remove();
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");
    shade.for(byId("z")).value = "A2";
    assertEquals(summary.value, "flow A2; bulk B1");
  } finally {
    uninstallDocument();
  }
});

Deno.test("an aborted root re-inserted later resumes its instance", () => {
  const byId = installDocument(`<div id="list"></div>`);
  try {
    const { shade, material, summary } = layerGraph();
    const document = byId("list").ownerDocument;
    const upgrade = (id: string) => {
      const root = document.createElement("fieldset");
      root.setAttribute("tt-instance", key);
      root.innerHTML = `<select id="${id}"></select>`;
      // As a lifecycle element: a new controller on every connection.
      return Object.assign(root, { abortController: new AbortController() });
    };
    const first = upgrade("a");
    const second = upgrade("b");
    byId("list").append(first, second);
    shade.for(byId("a")).value = "B1";
    material.for(byId("b")).value = "flow";
    assertEquals(summary.value, "bulk B1; flow A3");

    // Removing the root parks its instance: it leaves `.all` at once.
    first.remove();
    first.abortController.abort();
    assertEquals(summary.value, "flow A3");

    // The same element back in the document is the same instance.
    first.abortController = new AbortController();
    byId("list").prepend(first);
    assertEquals(shade.for(byId("a")).value, "B1");
    assertEquals(summary.value, "bulk B1; flow A3");

    // It parks again under its new controller.
    first.remove();
    first.abortController.abort();
    assertEquals(summary.value, "flow A3");

    // A fresh element with the same markup is a new instance.
    const third = upgrade("a");
    byId("list").prepend(third);
    assertEquals(shade.for(byId("a")).value, "A3");
    assertEquals(summary.value, "bulk A3; flow A3");
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

Deno.test("nested perInstance scopes each level and `.all` to its parent", () => {
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
    // Layers count once resolved, as their onLoad references do.
    for (const id of ["a1", "b1", "b2"]) material.for(byId(id));
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
    material.for(byId("a2"));
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
