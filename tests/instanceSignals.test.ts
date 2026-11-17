import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { parseHTML } from "linkedom";
import { type ReadonlySignal, rootSignals, signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";
import { update } from "./helpers/signalRuntime.ts";

const key = "layers_test";
const root = `tt-instance="${key}"`;

/**
 * A collection's page signals, rooted as its bundle roots them: each root of
 * `instanceKey` gets a fresh copy from `define`.
 */
function rooted<Graph extends Record<string, unknown>>(
  define: () => Graph,
  instanceKey = key,
): Graph {
  const page = define();
  for (const [name, signal] of Object.entries(page)) {
    (signal as { name?: string }).name ??= name;
  }
  rootSignals(page, define as never, instanceKey);
  return page;
}

/**
 * `.all` of one of a collection's page signals, which a definition reading
 * the collection is given typed (see `InDefinition`).
 */
const allOf = <Value>(signal: ReadonlySignal<Value>) =>
  (signal as unknown as { all: ReadonlySignal<Value[]> }).all;

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

/** A layer: material, shade and their description, one copy per root. */
function layerGraph() {
  const { Signal, Computed } = signalClasses(true);
  return rooted(() => {
    const material = new Signal<string>("bulk");
    const shade = new Signal<string>("A3");
    const description = new Computed(
      () => `${material.value} ${shade.value}`,
      [material, shade],
    );
    return { material, shade, description };
  });
}

/** Every layer root's description, as a page-wide collection reading them. */
function summaryOf(layers: ReturnType<typeof layerGraph>) {
  const { Computed } = signalClasses(true);
  return new Computed(
    () => allOf(layers.description).value.join("; "),
    [allOf(layers.description)],
  );
}

const change = (value: string) =>
  ({
    type: "change",
    target: { value, dataset: {}, name: "" },
  }) as unknown as Event;

Deno.test("a collection's signals resolve to the root enclosing them, or else the page's", () => {
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

    // Written as `onChange={fn.signals.update(signal.material)}` writes it:
    // the control's value, into the copy of the root enclosing it.
    update(
      (change("flow") as unknown as { target: unknown }).target,
      material.forInstance(a),
    );

    assertEquals(material.forInstance(a).value, "flow");
    assertEquals(material.forInstance(b).value, "bulk");
    // Computeds see only their own copy.
    assertEquals(description.forInstance(a).value, "flow A3");
    assertEquals(description.forInstance(b).value, "bulk A3");
    // The root itself belongs to its copy.
    assertEquals(material.forInstance(byId("one")).value, "flow");
    // Each copy's signals are named after their keys.
    assertEquals(description.forInstance(b).name, "description");
    assertEquals(material.name, "material");

    // Outside every root, and off the document, it is the page's own.
    assertStrictEquals(material.forInstance(byId("outside")), material);
    assertStrictEquals(material.forInstance({} as Element), material);
    assertEquals(material.value, "bulk");
    // `.all` belongs to the page's signals, not to a copy's.
    assertThrows(() => allOf(material.forInstance(a)), TypeError, "a copy");
  } finally {
    uninstallDocument();
  }
});

/**
 * A group's tint, and each box's count labelled with the tint of the group
 * around it: the box collection reads the group's by value.
 */
function groupedBoxes() {
  const { Signal, Computed } = signalClasses(true);
  const group = rooted(() => ({ tint: new Signal("grey") }));
  const box = rooted(() => {
    const count = new Signal(0);
    return {
      count,
      label: new Computed(() => `${group.tint.value} ${count.value}`),
    };
  }, `${key}-own`);
  return { ...group, ...box };
}

Deno.test("tt-link shares a collection between roots of another anywhere on the page", () => {
  const byId = installDocument(`
    <p id="a" tt-instance="${key}-own" tt-link="${key}=g1"></p>
    <p id="b" tt-instance="${key}-own" tt-link="${key}=g1"></p>
    <p id="c" tt-instance="${key}-own" tt-link="${key}=g2"></p>
    <section ${root}><p id="d" tt-instance="${key}-own"></p></section>`);
  try {
    const { tint, count, label } = groupedBoxes();
    tint.forInstance(byId("a")).value = "red";
    // Linked roots share the group but keep their own box.
    assertEquals(tint.forInstance(byId("b")).value, "red");
    count.forInstance(byId("a")).value = 2;
    assertEquals(label.forInstance(byId("a")).value, "red 2");
    assertEquals(label.forInstance(byId("b")).value, "red 0");
    // Another link, and a root enclosed the usual way, are separate.
    assertEquals(tint.forInstance(byId("c")).value, "grey");
    assertEquals(tint.forInstance(byId("d")).value, "grey");
    // A linked group counts once in `.all`.
    assertEquals(allOf(tint).value, ["red", "grey", "grey"]);
  } finally {
    uninstallDocument();
  }
});

Deno.test("tt-link alone makes separate elements one copy of a collection", () => {
  const byId = installDocument(`
    <output id="display" tt-link="${key}=c1"></output>
    <button id="up" tt-link="${key}=c1"></button>
    <button id="other" tt-link="${key}=c2"></button>`);
  try {
    const { Signal } = signalClasses(true);
    const { count } = rooted(() => ({ count: new Signal(0) }));
    count.forInstance(byId("up")).value = 3;
    assertEquals(count.forInstance(byId("display")).value, 3);
    assertEquals(count.forInstance(byId("other")).value, 0);
  } finally {
    uninstallDocument();
  }
});

Deno.test("tt-link links an inner collection by copy inside a linked outer one", () => {
  const link = (copy: string) => `tt-link="${key}=g ${key}-own=${copy}"`;
  const byId = installDocument(`
    <p id="box" ${link("g.0")}></p>
    <p id="button" ${link("g.0")}></p>
    <p id="other" ${link("g.1")}></p>`);
  try {
    const { tint, count } = groupedBoxes();
    // One copy's parts share its own box.
    count.forInstance(byId("button")).value = 4;
    assertEquals(count.forInstance(byId("box")).value, 4);
    // Another copy has its own, and shares the group.
    assertEquals(count.forInstance(byId("other")).value, 0);
    tint.forInstance(byId("other")).value = "red";
    assertEquals(tint.forInstance(byId("box")).value, "red");
  } finally {
    uninstallDocument();
  }
});

Deno.test("`.all` aggregates every resolved root in document order", () => {
  const byId = installDocument(`
    <div id="list">
      <fieldset id="one" ${root}><select id="a"></select></fieldset>
      <fieldset id="two" ${root}><select id="b"></select></fieldset>
    </div>`);
  try {
    const layers = layerGraph();
    const { shade, material } = layers;
    const summary = summaryOf(layers);
    const updates: string[] = [];
    (summary as unknown as EventTarget).addEventListener(
      "signal",
      () => updates.push(summary.value),
    );

    // Nothing scans the document: a root counts once something inside it
    // resolves a signal, as its onConnect / onChange references do.
    assertEquals(summary.value, "");
    shade.forInstance(byId("b")).value = "B1";
    assertEquals(summary.value, "bulk B1");
    material.forInstance(byId("a"));
    assertEquals(summary.value, "bulk A3; bulk B1");
    assertEquals(allOf(material).value, ["bulk", "bulk"]);

    // Later roots join in document order, wherever they are inserted.
    byId("list").insertAdjacentHTML(
      "afterbegin",
      `<fieldset id="zero" ${root}><select id="z"></select></fieldset>`,
    );
    material.forInstance(byId("z")).value = "flow";
    assertEquals(summary.value, "flow A3; bulk A3; bulk B1");

    // An upgraded root (one with an abortController) leaves when it aborts.
    const controller = new AbortController();
    const upgraded = byId("list").ownerDocument.createElement("fieldset");
    upgraded.setAttribute("tt-instance", key);
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

Deno.test("an aborted root re-inserted later resumes its copy", () => {
  const byId = installDocument(`<div id="list"></div>`);
  try {
    const layers = layerGraph();
    const { shade, material } = layers;
    const summary = summaryOf(layers);
    const document = byId("list").ownerDocument;
    const upgrade = (id: string) => {
      const element = document.createElement("fieldset");
      element.setAttribute("tt-instance", key);
      element.innerHTML = `<select id="${id}"></select>`;
      // As a lifecycle element: a new controller on every connection.
      return Object.assign(element, {
        abortController: new AbortController(),
      });
    };
    const first = upgrade("a");
    const second = upgrade("b");
    byId("list").append(first, second);
    shade.forInstance(byId("a")).value = "B1";
    material.forInstance(byId("b")).value = "flow";
    assertEquals(summary.value, "bulk B1; flow A3");

    // Removing the root parks its copy: it leaves `.all` at once.
    first.remove();
    first.abortController.abort();
    assertEquals(summary.value, "flow A3");

    // The same element back in the document is the same copy.
    first.abortController = new AbortController();
    byId("list").prepend(first);
    assertEquals(shade.forInstance(byId("a")).value, "B1");
    assertEquals(summary.value, "bulk B1; flow A3");

    // It parks again under its new controller.
    first.remove();
    first.abortController.abort();
    assertEquals(summary.value, "flow A3");

    // A fresh element with the same markup is a new copy.
    const third = upgrade("a");
    byId("list").prepend(third);
    assertEquals(shade.forInstance(byId("a")).value, "A3");
    assertEquals(summary.value, "bulk A3; flow A3");
  } finally {
    uninstallDocument();
  }
});

/**
 * A note whose layers read its isolation, while it lists their labels:
 * imports cannot go both ways, so the note is two collections rooted on
 * the one element, its settings (which the layers import and read by value)
 * and its summary (which imports the layers and reads their `.all`).
 */
function noteGraph() {
  const { Signal, Computed } = signalClasses(true);
  const settings = rooted(
    () => ({ isolation: new Signal<string>("cheekguard") }),
    "settings_test",
  );
  const layers = rooted(() => {
    const material = new Signal<string>("bulk");
    return {
      material,
      label: new Computed(
        () => `${material.value} (${settings.isolation.value})`,
      ),
    };
  });
  const summary = rooted(() => ({
    summary: new Computed(() => allOf(layers.label).value.join("; ")),
  }), "summary_test");
  return { ...settings, ...layers, ...summary };
}

Deno.test("a parent reads the copies inside it, and its children read the parent around them", () => {
  const note = `tt-instance="settings_test summary_test"`;
  const byId = installDocument(`
    <form id="noteA" ${note}>
      <select id="isoA"></select>
      <output id="sumA"></output>
      <div id="layersA">
        <fieldset ${root}><select id="a1"></select></fieldset>
      </div>
    </form>
    <form id="noteB" ${note}>
      <output id="sumB"></output>
      <fieldset ${root}><select id="b1"></select></fieldset>
      <fieldset ${root}><select id="b2"></select></fieldset>
    </form>`);
  try {
    const { isolation, material, label, summary } = noteGraph();
    const sumA = byId("sumA");
    const sumB = byId("sumB");
    // Layers count once resolved, as their onConnect references do.
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
      `<fieldset ${root}><select id="a2"></select></fieldset>`,
    );
    material.forInstance(byId("a2"));
    assertEquals(summary.forInstance(sumA).value, "bulk (rdam); bulk (rdam)");
    assertEquals(
      summary.forInstance(sumB).value,
      "bulk (cheekguard); flow (cheekguard)",
    );
    // The page's own summary covers every layer.
    assertEquals(allOf(material).value.length, 4);
  } finally {
    uninstallDocument();
  }
});

Deno.test("a root's seed starts its new copy from the rendered values", () => {
  const seed = (values: unknown) =>
    `tt-seed='${JSON.stringify({ [key]: values })}'`;
  const byId = installDocument(`
    <fieldset ${root} ${seed({ material: "flow", shade: "B1" })}>
      <select id="a"></select>
    </fieldset>
    <fieldset ${root}><select id="b"></select></fieldset>
    <fieldset ${root} ${seed({ description: "x", missing: 1 })}>
      <select id="c"></select>
    </fieldset>
    <fieldset ${root} tt-seed='not json'><select id="d"></select></fieldset>
    <fieldset ${root} tt-seed='{"other_key":{"shade":"C2"}}'>
      <select id="e"></select>
    </fieldset>`);
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const layers = layerGraph();
    const { material, shade, description } = layers;
    const summary = summaryOf(layers);
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

Deno.test("a resumed copy keeps its values over its seed", () => {
  const byId = installDocument(`<div id="list"></div>`);
  try {
    const { shade } = layerGraph();
    const element = byId("list").ownerDocument.createElement("fieldset");
    element.setAttribute("tt-instance", key);
    element.setAttribute("tt-seed", JSON.stringify({ [key]: { shade: "B1" } }));
    element.innerHTML = `<select id="a"></select>`;
    Object.assign(element, { abortController: new AbortController() });
    byId("list").append(element);
    assertEquals(shade.forInstance(byId("a")).value, "B1");
    shade.forInstance(byId("a")).value = "C2";

    // Parked, then back: the edited value, not the seed.
    element.remove();
    (element as unknown as { abortController: AbortController })
      .abortController.abort();
    Object.assign(element, { abortController: new AbortController() });
    byId("list").append(element);
    assertEquals(shade.forInstance(byId("a")).value, "C2");
  } finally {
    uninstallDocument();
  }
});

Deno.test("seed renders the tt-seed the runtime reads, one per collection on a shared root", () => {
  const notes = new Signals(import.meta.url, ({ Signal, Computed }) => {
    const isolation = new Signal<string>("rdam");
    return {
      isolation,
      count: new Signal<number>(1),
      label: new Computed(() => isolation.value),
    };
  });
  const layers = new Signals(import.meta.url, ({ Signal }) => ({
    material: new Signal<string>("bulk"),
  }));
  assertEquals(
    notes.seed({ isolation: "isolite" }),
    JSON.stringify({ [notes.instanceKey]: { isolation: "isolite" } }),
  );
  // @ts-expect-error computeds cannot be seeded
  notes.seed({ label: "x" });
  // @ts-expect-error another collection's signal
  notes.seed({ material: "flow" });
  // @ts-expect-error the value must match the signal's type
  notes.seed({ count: "2" });

  // One element rooting both holds each one's seed under its key.
  const both = JSON.stringify({
    ...JSON.parse(notes.seed({ isolation: "isolite" })),
    ...JSON.parse(layers.seed({ material: "flow" })),
  });
  const byId = installDocument(`
    <form tt-instance="${notes.instanceKey} ${layers.instanceKey}"
      tt-seed='${both}'>
      <select id="a"></select>
    </form>`);
  try {
    const { Signal } = signalClasses(true);
    const note = rooted(
      () => ({ isolation: new Signal<string>("rdam") }),
      notes.instanceKey,
    );
    const layer = rooted(
      () => ({ material: new Signal<string>("bulk") }),
      layers.instanceKey,
    );
    assertEquals(note.isolation.forInstance(byId("a")).value, "isolite");
    assertEquals(layer.material.forInstance(byId("a")).value, "flow");
  } finally {
    uninstallDocument();
  }
});

Deno.test("evaluateUsingInitialValues reports a seeded root's values", () => {
  const notes = new Signals(import.meta.url, ({ Signal, Computed }) => {
    const page = new Signal<string>("light");
    const material = new Signal<string>("bulk");
    const shade = new Signal<string>("A3");
    return {
      page,
      material,
      shade,
      description: new Computed(
        () => `${material.value} ${shade.value} (${page.value})`,
      ),
    };
  });
  assertEquals(notes.instanceKey.startsWith("instanceSignals_test_"), true);
  // Inputs and a seed both start the signals they name.
  assertEquals(
    notes.evaluateUsingInitialValues({ page: "dark" }, { material: "flow" }),
    {
      page: "dark",
      material: "flow",
      shade: "A3",
      description: "flow A3 (dark)",
    },
  );
  // Without a seed, a fresh copy.
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
    // @ts-expect-error not a signal of this collection
    () => notes.evaluateUsingInitialValues({}, { missing: "x" }),
    TypeError,
    "'missing'",
  );
  assertThrows(
    // @ts-expect-error computeds are not inputs
    () => notes.evaluateUsingInitialValues({ description: "x" }),
    TypeError,
  );
});
