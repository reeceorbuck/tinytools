import { assertEquals, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import {
  type FlattenScopes,
  flattenScopes,
  signalClasses,
} from "../signals.ts";
import { Signals } from "../clientTools.ts";

const key = "layers_test";
const root = `tt-instance="${key}"`;
/** `layerGraph` returns its scope under `layer`, so that level is named. */
const layerKey = `${key}-layer`;
const layers = `tt-instance="${layerKey}"`;

/** What a factory returning `definitions` exports, as a collection does. */
const exported = <Definitions>(definitions: Definitions) =>
  flattenScopes(definitions) as unknown as FlattenScopes<Definitions>;

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
  const { Signal, Computed, Scope } = signalClasses(true, key);
  const layer = new Scope(() => {
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
  return exported({ layer, summary });
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
      <fieldset id="one" ${layers}><select id="a"></select></fieldset>
      <fieldset id="two" tt-instance="notes_test ${layerKey}">
        <select id="b"></select>
      </fieldset>
      <select id="outside"></select>
    </div>`);
  try {
    const { material, description } = layerGraph();
    const a = byId("a");
    const b = byId("b");

    // Written through the handler path, as `onChange={signal.material}` does.
    material.forInstance(a);
    (material as unknown as {
      handleEvent(target: unknown, event: Event): unknown;
    }).handleEvent(a, change("flow"));

    assertEquals(material.forInstance(a).value, "flow");
    assertEquals(material.forInstance(b).value, "bulk");
    // Computeds inside a Scope see only their own instance.
    assertEquals(description.forInstance(a).value, "flow A3");
    assertEquals(description.forInstance(b).value, "bulk A3");
    // The root itself belongs to its instance.
    assertEquals(material.forInstance(byId("one")).value, "flow");
    // Each instance's signals are named after their keys.
    assertEquals(description.forInstance(b).name, "description");
    assertEquals(material.name, "material");

    assertThrows(
      () => material.forInstance(byId("outside")),
      Error,
      "instance root",
    );
    // Instance signals have no single value.
    assertThrows(() => (material as unknown as { value: unknown }).value);
  } finally {
    uninstallDocument();
  }
});

Deno.test("tt-link shares an enclosing level between roots anywhere on the page", () => {
  const byId = installDocument(`
    <p id="a" tt-instance="${key}-own" tt-link="${key}=g1"></p>
    <p id="b" tt-instance="${key}-own" tt-link="${key}=g1"></p>
    <p id="c" tt-instance="${key}-own" tt-link="${key}=g2"></p>
    <section ${root}><p id="d" tt-instance="${key}-own"></p></section>`);
  try {
    const { Signal, Computed, Scope } = signalClasses(true, key);
    const { tint, count, label } = exported(
      new Scope(() => {
        const tint = new Signal("grey");
        return {
          tint,
          own: new Scope(() => {
            const count = new Signal(0);
            return {
              count,
              label: new Computed(() => `${tint.value} ${count.value}`),
            };
          }),
        };
      }),
    );
    tint.forInstance(byId("a")).value = "red";
    // Linked roots share the enclosing level but keep their own level.
    assertEquals(tint.forInstance(byId("b")).value, "red");
    count.forInstance(byId("a")).value = 2;
    assertEquals(label.forInstance(byId("a")).value, "red 2");
    assertEquals(label.forInstance(byId("b")).value, "red 0");
    // Another link, and a root enclosed the usual way, are separate.
    assertEquals(tint.forInstance(byId("c")).value, "grey");
    assertEquals(tint.forInstance(byId("d")).value, "grey");
    // A linked group counts once in `.all`.
    assertEquals(tint.all.value, ["red", "grey", "grey"]);
  } finally {
    uninstallDocument();
  }
});

Deno.test("tt-link alone makes separate elements one instance of a single level", () => {
  const byId = installDocument(`
    <output id="display" tt-link="${key}=c1"></output>
    <button id="up" tt-link="${key}=c1"></button>
    <button id="other" tt-link="${key}=c2"></button>`);
  try {
    const { Signal, Scope } = signalClasses(true, key);
    const { count } = exported(new Scope(() => ({ count: new Signal(0) })));
    count.forInstance(byId("up")).value = 3;
    assertEquals(count.forInstance(byId("display")).value, 3);
    assertEquals(count.forInstance(byId("other")).value, 0);
  } finally {
    uninstallDocument();
  }
});

Deno.test("tt-link links an inner level by copy inside a linked outer level", () => {
  const link = (copy: string) => `tt-link="${key}=g ${key}-own=${copy}"`;
  const byId = installDocument(`
    <p id="box" ${link("g.0")}></p>
    <p id="button" ${link("g.0")}></p>
    <p id="other" ${link("g.1")}></p>`);
  try {
    const { Signal, Scope } = signalClasses(true, key);
    const { tint, count } = exported(
      new Scope(() => ({
        tint: new Signal("grey"),
        own: new Scope(() => ({ count: new Signal(0) })),
      })),
    );
    // One copy's parts share its own level.
    count.forInstance(byId("button")).value = 4;
    assertEquals(count.forInstance(byId("box")).value, 4);
    // Another copy has its own, and shares the outer level.
    assertEquals(count.forInstance(byId("other")).value, 0);
    tint.forInstance(byId("other")).value = "red";
    assertEquals(tint.forInstance(byId("box")).value, "red");
  } finally {
    uninstallDocument();
  }
});

Deno.test("`.all` aggregates every resolved instance in document order", () => {
  const byId = installDocument(`
    <div id="list">
      <fieldset id="one" ${layers}><select id="a"></select></fieldset>
      <fieldset id="two" ${layers}><select id="b"></select></fieldset>
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
    shade.forInstance(byId("b")).value = "B1";
    assertEquals(summary.value, "bulk B1");
    material.forInstance(byId("a"));
    assertEquals(summary.value, "bulk A3; bulk B1");
    assertEquals(material.all.value, ["bulk", "bulk"]);

    // Later roots join in document order, wherever they are inserted.
    byId("list").insertAdjacentHTML(
      "afterbegin",
      `<fieldset id="zero" ${layers}><select id="z"></select></fieldset>`,
    );
    material.forInstance(byId("z")).value = "flow";
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");

    // An upgraded root (one with an abortController) leaves when it aborts.
    const controller = new AbortController();
    const upgraded = byId("list").ownerDocument.createElement("fieldset");
    upgraded.setAttribute("tt-instance", layerKey);
    upgraded.innerHTML = `<select id="u"></select>`;
    Object.assign(upgraded, { abortController: controller });
    byId("list").append(upgraded);
    material.forInstance(byId("u")).value = "glass";
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1; glass A3");
    upgraded.remove();
    controller.abort();
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");
    assertEquals(updates.at(-1), "flow A3; bulk A3; bulk B1");

    // Without an abort, a removed root is left out of values but not dropped.
    byId("one").remove();
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");
    shade.forInstance(byId("z")).value = "A2";
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
      root.setAttribute("tt-instance", layerKey);
      root.innerHTML = `<select id="${id}"></select>`;
      // As a lifecycle element: a new controller on every connection.
      return Object.assign(root, { abortController: new AbortController() });
    };
    const first = upgrade("a");
    const second = upgrade("b");
    byId("list").append(first, second);
    shade.forInstance(byId("a")).value = "B1";
    material.forInstance(byId("b")).value = "flow";
    assertEquals(summary.value, "bulk B1; flow A3");

    // Removing the root parks its instance: it leaves `.all` at once.
    first.remove();
    first.abortController.abort();
    assertEquals(summary.value, "flow A3");

    // The same element back in the document is the same instance.
    first.abortController = new AbortController();
    byId("list").prepend(first);
    assertEquals(shade.forInstance(byId("a")).value, "B1");
    assertEquals(summary.value, "bulk B1; flow A3");

    // It parks again under its new controller.
    first.remove();
    first.abortController.abort();
    assertEquals(summary.value, "flow A3");

    // A fresh element with the same markup is a new instance.
    const third = upgrade("a");
    byId("list").prepend(third);
    assertEquals(shade.forInstance(byId("a")).value, "A3");
    assertEquals(summary.value, "bulk A3; flow A3");
  } finally {
    uninstallDocument();
  }
});

Deno.test("per-instance signals resolve only inside an instance root", () => {
  const { Signal, Scope } = signalClasses(false);
  const { material } = exported(
    new Scope(() => ({ material: new Signal("bulk") })),
  );
  // Aggregates can be declared during server-side validation.
  void material.all;
  assertThrows(
    () => material.forInstance({} as Element),
    Error,
    "inside an instance root",
  );
});

Deno.test("Signals collections expose an instance root and evaluate instances", () => {
  const signals = new Signals(
    import.meta.url,
    ({ Signal, Computed, Scope }) => {
      const layer = new Scope(() => ({ material: new Signal("bulk") }));
      const count = new Computed(
        () => layer.material.all.value.length,
        [layer.material.all],
      );
      return { layer, isolation: new Signal<string>("rdam"), count };
    },
  );
  assertEquals(signals.instanceKey.startsWith("instanceSignals_test_"), true);
  assertEquals(signals.scopes.layer.key, `${signals.instanceKey}-layer`);

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
  const { Signal, Computed, Scope } = signalClasses(true, key);
  return exported(
    new Scope(() => {
      const isolation = new Signal<string>("cheekguard");
      const layer = new Scope(() => {
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
      return { isolation, layer, summary };
    }),
  );
}

Deno.test("nested Scopes each scope a level and `.all` to its parent", () => {
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
    for (const id of ["a1", "b1", "b2"]) material.forInstance(byId(id));
    assertEquals(summary.forInstance(sumA).value, "bulk (cheekguard)");
    assertEquals(
      summary.forInstance(sumB).value,
      "bulk (cheekguard); bulk (cheekguard)",
    );

    // Each note keeps its own isolation and layers.
    isolation.forInstance(byId("isoA")).value = "rdam";
    material.forInstance(byId("b2")).value = "flow";
    assertEquals(label.forInstance(byId("a1")).value, "bulk (rdam)");
    assertEquals(summary.forInstance(sumA).value, "bulk (rdam)");
    assertEquals(
      summary.forInstance(sumB).value,
      "bulk (cheekguard); flow (cheekguard)",
    );

    // A layer added to one note joins only that note's summary.
    byId("layersA").insertAdjacentHTML(
      "beforeend",
      `<fieldset ${layerRoot}><select id="a2"></select></fieldset>`,
    );
    material.forInstance(byId("a2"));
    assertEquals(summary.forInstance(sumA).value, "bulk (rdam); bulk (rdam)");
    assertEquals(
      summary.forInstance(sumB).value,
      "bulk (cheekguard); flow (cheekguard)",
    );

    // Layer signals need a layer root; nested `.all` is read inside the note.
    assertThrows(
      () => material.forInstance(byId("isoA")),
      Error,
      `${key}-layer`,
    );
    assertThrows(() => material.all, TypeError, "nested");
  } finally {
    uninstallDocument();
  }
});

Deno.test("a nested Scope must be returned under a key", () => {
  const { Signal, Scope } = signalClasses(true, key);
  assertThrows(
    () => new Scope(() => new Scope(() => ({ inner: new Signal(1) }))),
    TypeError,
    "under a key",
  );
});

Deno.test("a Scope's signals are exported only by returning the Scope", () => {
  const { Signal, Scope } = signalClasses(true, key);
  const box = new Scope(() => ({ count: new Signal(0) }));
  assertThrows(() => exported({ ...box }), TypeError, "spread");
  // Its level has no key until it is returned.
  assertThrows(() => box.count.forInstance({} as Element), Error, "returned");
  exported({ box });
  assertThrows(() => exported({ again: box }), TypeError, "returned once");
  assertThrows(
    () =>
      exported({
        one: new Scope(() => ({ count: new Signal(0) })),
        two: new Scope(() => ({ count: new Signal(0) })),
      }),
    TypeError,
    "'count' is defined twice",
  );
});

Deno.test("scopes only has the collection's named Scopes", () => {
  const notes = new Signals(
    import.meta.url,
    ({ Signal, Scope }) =>
      new Scope(() => ({
        isolation: new Signal<string>("rdam"),
        layer: new Scope(() => ({ material: new Signal<string>("bulk") })),
        tooth: new Scope(() => ({ surface: new Signal<string>("O") })),
      })),
  );
  assertEquals(notes.scopes.layer.key, `${notes.instanceKey}-layer`);
  void notes.scopes.tooth.key;
  // @ts-expect-error not a Scope of this collection
  void (() => notes.scopes.layers);

  const flat = new Signals(
    import.meta.url,
    ({ Signal, Scope }) => new Scope(() => ({ count: new Signal<number>(0) })),
  );
  // @ts-expect-error a Scope returned directly is unnamed
  void (() => flat.scopes.count);
});

Deno.test("a root's seed starts its new instance from the rendered values", () => {
  const seed = (values: unknown) =>
    `tt-seed='${JSON.stringify({ [layerKey]: values })}'`;
  const byId = installDocument(`
    <fieldset ${layers} ${seed({ material: "flow", shade: "B1" })}>
      <select id="a"></select>
    </fieldset>
    <fieldset ${layers}><select id="b"></select></fieldset>
    <fieldset ${layers} ${seed({ description: "x", missing: 1 })}>
      <select id="c"></select>
    </fieldset>
    <fieldset ${layers} tt-seed='not json'><select id="d"></select></fieldset>
    <fieldset ${layers} tt-seed='{"other_key":{"shade":"C2"}}'>
      <select id="e"></select>
    </fieldset>`);
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const { material, shade, description, summary } = layerGraph();
    for (const id of ["a", "b", "c", "d", "e"]) material.forInstance(byId(id));
    assertEquals(material.forInstance(byId("a")).value, "flow");
    assertEquals(shade.forInstance(byId("a")).value, "B1");
    // Computeds and aggregates start from the seed.
    assertEquals(description.forInstance(byId("a")).value, "flow B1");
    assertEquals(
      summary.value,
      "flow B1; bulk A3; bulk A3; bulk A3; bulk A3",
    );
    // Another collection's seed on the root is not this one's.
    assertEquals(shade.forInstance(byId("e")).value, "A3");

    // Computeds and unknown names are reported and skipped, as is bad JSON.
    assertEquals(description.forInstance(byId("c")).value, "bulk A3");
    assertEquals(errors.length, 3);
    assertEquals(String(errors[0][0]).includes("'description'"), true);
    assertEquals(String(errors[1][0]).includes("'missing'"), true);
    assertEquals(String(errors[2][0]).includes("malformed"), true);
  } finally {
    console.error = consoleError;
    uninstallDocument();
  }
});

Deno.test("a resumed instance keeps its values over its seed", () => {
  const byId = installDocument(`<div id="list"></div>`);
  try {
    const { shade } = layerGraph();
    const root = byId("list").ownerDocument.createElement("fieldset");
    root.setAttribute("tt-instance", layerKey);
    root.setAttribute(
      "tt-seed",
      JSON.stringify({ [layerKey]: { shade: "B1" } }),
    );
    root.innerHTML = `<select id="a"></select>`;
    Object.assign(root, { abortController: new AbortController() });
    byId("list").append(root);
    assertEquals(shade.forInstance(byId("a")).value, "B1");
    shade.forInstance(byId("a")).value = "C2";

    // Parked, then back: the edited value, not the seed.
    root.remove();
    (root as unknown as { abortController: AbortController }).abortController
      .abort();
    Object.assign(root, { abortController: new AbortController() });
    byId("list").append(root);
    assertEquals(shade.forInstance(byId("a")).value, "C2");
  } finally {
    uninstallDocument();
  }
});

Deno.test("seed and scopes render the tt-seed the runtime reads", () => {
  const notes = new Signals(
    import.meta.url,
    ({ Signal, Computed, Scope }) => {
      const note = new Scope(() => {
        const isolation = new Signal<string>("rdam");
        return {
          isolation,
          layer: new Scope(() => ({
            material: new Signal<string>("bulk"),
            count: new Signal<number>(1),
          })),
          label: new Computed(() => isolation.value),
        };
      });
      return { note, page: new Signal<string>("") };
    },
  );
  const { note, layer } = notes.scopes;
  assertEquals(
    note.seed({ isolation: "isolite" }),
    JSON.stringify({ [`${notes.instanceKey}-note`]: { isolation: "isolite" } }),
  );
  assertEquals(
    layer.seed({ material: "flow", count: 2 }),
    JSON.stringify({ [layer.key]: { material: "flow", count: 2 } }),
  );
  // @ts-expect-error computeds cannot be seeded
  note.seed({ label: "x" });
  // @ts-expect-error page-wide signals are not per-instance
  note.seed({ page: "x" });
  // @ts-expect-error layer signals are seeded on a layer root
  note.seed({ material: "flow" });
  // @ts-expect-error note signals are seeded on the note root
  layer.seed({ isolation: "x" });
  // @ts-expect-error the value must match the signal's type
  layer.seed({ count: "2" });
  // @ts-expect-error only a Scope returned directly is seeded by `seed`
  notes.seed({ isolation: "x" });

  const flat = new Signals(
    import.meta.url,
    ({ Signal, Scope }) => new Scope(() => ({ count: new Signal<number>(0) })),
  );
  assertEquals(
    flat.seed({ count: 2 }),
    JSON.stringify({ [flat.instanceKey]: { count: 2 } }),
  );

  // The rendered attribute seeds the matching level in the browser.
  const byId = installDocument(`
    <form tt-instance="${note.key}"
      tt-seed='${note.seed({ isolation: "isolite" })}'>
      <fieldset tt-instance="${layer.key}"
        tt-seed='${layer.seed({ material: "flow" })}'>
        <select id="a"></select>
      </fieldset>
    </form>`);
  try {
    const { Signal, Scope } = signalClasses(true, notes.instanceKey);
    const graph = exported({
      note: new Scope(() => ({
        isolation: new Signal<string>("rdam"),
        layer: new Scope(() => ({ material: new Signal<string>("bulk") })),
      })),
    });
    assertEquals(graph.isolation.forInstance(byId("a")).value, "isolite");
    assertEquals(graph.material.forInstance(byId("a")).value, "flow");
  } finally {
    uninstallDocument();
  }
});

Deno.test("evaluateUsingInitialValues reports a seeded instance's values", () => {
  const notes = new Signals(
    import.meta.url,
    ({ Signal, Computed, Scope }) => {
      const page = new Signal<string>("light");
      const note = new Scope(() => {
        const material = new Signal<string>("bulk");
        const shade = new Signal<string>("A3");
        return {
          material,
          shade,
          layer: new Scope(() => ({
            // Inner levels start fresh but read the seeded outer instance.
            label: new Computed(() => `layer of ${material.value}`),
          })),
          description: new Computed(
            () => `${material.value} ${shade.value} (${page.value})`,
          ),
        };
      });
      // A second level takes its own names from the same seed.
      const tooth = new Scope(() => ({ surface: new Signal<string>("O") }));
      return { page, note, tooth };
    },
  );
  assertEquals(
    notes.evaluateUsingInitialValues({ page: "dark" }, {
      material: "flow",
      surface: "MO",
    }),
    {
      page: "dark",
      material: "flow",
      shade: "A3",
      label: "layer of flow",
      description: "flow A3 (dark)",
      surface: "MO",
    },
  );
  // Without a seed, a fresh instance as before.
  assertEquals(
    notes.evaluateUsingInitialValues().description,
    "bulk A3 (light)",
  );

  assertThrows(
    // @ts-expect-error computeds cannot be seeded
    () => notes.evaluateUsingInitialValues({}, { description: "x" }),
    TypeError,
    "'description'",
  );
  assertThrows(
    // @ts-expect-error page-wide signals are inputs, not seeds
    () => notes.evaluateUsingInitialValues({}, { page: "x" }),
    TypeError,
    "'page'",
  );
  assertThrows(
    // @ts-expect-error not a signal of this collection
    () => notes.evaluateUsingInitialValues({}, { missing: "x" }),
    TypeError,
    "'missing'",
  );
});
