/**
 * Optional roots. A collection is page-wide
 * outside its roots, and inside a root (`<SignalRoot>`, or an instance
 * of a `tiny.SignalComponent` whose factory imports it with `withRoot()`)
 * each root has its own copy.
 * Collections nest by importing each other.
 * The cases mirror the dental restorative note (a parent reading its
 * children's `.all`) and the ColorBox trial (a child reading its parent's
 * signals, rooted and linked by a component).
 */
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { parseHTML } from "linkedom";
import { pathToFileURL } from "node:url";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  imports,
  registeredClientTools,
  SignalComponent,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import { jsx } from "../jsx-runtime.ts";
import { runHandler, tiny as tinyApi } from "../honoFactory.tsx";
import { instanceRuntime } from "../signalModules.ts";
import type { ReadonlySignal, Signal } from "../signals.ts";
import { optimized } from "../honoFactory.tsx";

/** Collections made here get keys of their own, as an app's do. */
const tiny = optimized(import.meta.url);

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

/** Installs a linkedom document as the global one the signal runtime reads. */
function installDocument(body: string) {
  const window = parseHTML(`<html><body>${body}</body></html>`);
  Object.assign(globalThis, { document: window.document });
  return {
    byId: (id: string) => window.document.getElementById(id)!,
    document: window.document,
  };
}

function uninstallDocument() {
  delete (globalThis as Record<string, unknown>).document;
}

/** A built file of `directory`'s handlers, imported. */
const built = (directory: string, file: string) =>
  import(pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${file}`).href);

/**
 * The built bundle holding `collection`'s signal `name`, with the per-root
 * runtime loaded, as a handler running inside a root waits for it.
 */
const loader = (directory: string) =>
async (
  collection: { _handlerFilenames: ReadonlyMap<string, string> },
  name: string,
) => {
  const bundle = await built(
    directory,
    `${collection._handlerFilenames.get(name)}.js`,
  );
  await built(directory, instanceRuntime.file);
  return bundle;
};

/** A restoration layer: material and shade, described per layer. */
function layerSignals() {
  return new tiny.Signals(({ Signal, Computed }) => {
    const material = new Signal("Bulk");
    const shade = new Signal("A3");
    return {
      material,
      shade,
      description: new Computed(() => `${material.value} shade ${shade.value}`),
    };
  });
}

/** A note listing its own layers, read through `.all`. */
function noteSignals(layer: ReturnType<typeof layerSignals>) {
  return new tiny.Signals(layer, ({ signal }) => ({
    isolation: "Rubber dam",
    noteText() {
      // Until a layer registers (and on the server), the one default layer.
      const described = signal.description.all.value;
      const layers = described.length
        ? described
        : [signal.description.initialValue];
      return `${this.isolation.value}: ${layers.join("; ")}`;
    },
  }));
}

Deno.test({
  name:
    "a collection is page-wide outside its roots, and a note reads the layers inside its own root",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/optional-roots-notes";
    const layer = layerSignals();
    const note = noteSignals(layer);
    const checkTypes = async () => {
      const { signal, SignalRoot } = await imports(note);
      // Outside every root a signal is the page's, so it has a value.
      const text: string = signal.noteText.value;
      // One collection: its root renders.
      void SignalRoot({ children: jsx("p", {}) as never });
      void text;
      // Two collections have no one root to render.
      const two = await imports(note, layer);
      // @ts-expect-error a call holding two collections has no root
      void two.SignalRoot({ children: jsx("p", {}) as never });
      // Inside a definition, another collection's signal has `.all`.
      new tiny.Signals(layer, ({ signal }) => {
        const all: ReadonlySignal<string[]> = signal.description.all;
        return { count: () => all.value.length };
      });
    };
    void checkTypes;
    try {
      // The server renders a fresh note, with its one default layer.
      assertEquals(await note.evaluateUsingInitialValues(), {
        isolation: "Rubber dam",
        noteText: "Rubber dam: Bulk shade A3",
      });
      await buildScriptFiles({ fresh: true, publicDir: directory });

      // `self` roots the one collection a call imports.
      const tag = (html: unknown) => /^<[^>]*>/.exec(String(html))![0];
      const forNote = await imports(note);
      assertEquals(
        tag(forNote.SignalRoot({ children: jsx("section", {}) as never })),
        `<section is="tt-section" tt-instance="${note.instanceKey}">`,
      );
      const forLayer = await imports(layer);
      assertEquals(
        tag(forLayer.SignalRoot({ children: jsx("div", {}) as never })),
        `<div is="tt-div" tt-instance="${layer.instanceKey}">`,
      );
      // A call importing two cannot say which it roots: each copy is a
      // component of its own, importing just its collection.
      const both = await imports(layer, note);
      assertThrows(
        // @ts-expect-error a call holding two collections has no root
        () => both.SignalRoot({ children: jsx("section", {}) as never }),
        TypeError,
        "a component of its own",
      );
      // Outside a component's factory, `withRoot()` says the same.
      await assertRejects(
        () => imports(layer, note.withRoot()),
        TypeError,
        "a component of its own",
      );
      // Two roots on one element: nested, from two calls.
      const nested = String(
        forLayer.SignalRoot({
          children: forNote.SignalRoot({
            children: jsx("section", {}) as never,
          }),
        }),
      );
      assertEquals(
        tag(nested),
        `<section is="tt-section" tt-instance="${note.instanceKey} ${layer.instanceKey}">`,
      );

      const { byId, document } = installDocument(`
        <section id="n1" tt-instance="${note.instanceKey}">
          <div id="l1" tt-instance="${layer.instanceKey}"></div>
          <div id="l2" tt-instance="${layer.instanceKey}"></div>
        </section>
        <section id="n2" tt-instance="${note.instanceKey}">
          <div id="l3" tt-instance="${layer.instanceKey}"></div>
        </section>
        <p id="outside"></p>`);
      try {
        const load = loader(directory);
        const layers = await load(layer, "material");
        const notes = await load(note, "noteText");
        // The note resolves before any of its layers: the default layer.
        const text1 = notes.noteText.forInstance(byId("n1"));
        assertEquals(text1.value, "Rubber dam: Bulk shade A3");
        // Each layer that registers joins only its own note's text.
        layers.material.forInstance(byId("l1")).value = "Flow";
        layers.shade.forInstance(byId("l2")).value = "B1";
        layers.material.forInstance(byId("l3")).value = "Gaenial";
        assertEquals(
          text1.value,
          "Rubber dam: Flow shade A3; Bulk shade B1",
        );
        const text2 = notes.noteText.forInstance(byId("n2"));
        assertEquals(text2.value, "Rubber dam: Gaenial shade A3");
        // The note's own signals still drive it.
        notes.isolation.forInstance(byId("n2")).value = "Isolite";
        assertEquals(text2.value, "Isolite: Gaenial shade A3");
        // A layer added later joins in document order.
        const added = document.createElement("div");
        added.setAttribute("tt-instance", layer.instanceKey);
        byId("n1").prepend(added);
        layers.material.forInstance(added).value = "Liner";
        assertEquals(
          text1.value,
          "Rubber dam: Liner shade A3; Flow shade A3; Bulk shade B1",
        );
        // `.all` covers every root's copy, not the page's own value.
        assertEquals(notes.noteText.all.value.length, 2);

        // Outside every root, the signals are the page's: one value, which
        // the roots' copies do not share.
        assertEquals(
          layers.material.forInstance(byId("outside")),
          layers.material,
        );
        assertEquals(layers.material.value, "Bulk");
        layers.material.value = "Page";
        assertEquals(layers.description.value, "Page shade A3");
        assertEquals(
          text1.value,
          "Rubber dam: Liner shade A3; Flow shade A3; Bulk shade B1",
        );
        // The page's note reads every layer root on the page.
        assertEquals(
          notes.noteText.value,
          "Rubber dam: Liner shade A3; Flow shade A3; Bulk shade B1; Gaenial shade A3",
        );
      } finally {
        uninstallDocument();
      }
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

/** A group of boxes: one recolor and tint per group, or the page's. */
function sharedSignals() {
  return new tiny.Signals(({ Signal, Trigger }) => ({
    recolor: new Trigger(),
    tint: new Signal("grey"),
  }));
}

/** One box: its own presses, following its group's recolor and tint. */
function boxSignals(shared: ReturnType<typeof sharedSignals>) {
  return new tiny.Signals(shared, ({ signal, Trigger, Computed }) => {
    const press = new Trigger();
    return {
      press,
      hue: new Computed((hue: number) => (hue + 90) % 360, [press], 0),
      // Listed as a dependency: the recolor of the group around the box.
      recolors: new Computed(
        (count: number) => count + 1,
        [signal.recolor],
        0,
      ),
      // Read by value: the tint of the group around the box.
      label() {
        return `${signal.tint.value} box`;
      },
    };
  });
}

Deno.test({
  name:
    "a rooted collection reads the root around it by value, or else the page's",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/optional-roots-boxes";
    const shared = sharedSignals();
    const box = boxSignals(shared);
    const checkTypes = () => {
      new tiny.Signals(shared, ({ signal }) => {
        // Another collection's signal is the one around the reader's.
        const tint: Signal<string> = signal.tint;
        return { copy: () => tint.value };
      });
    };
    void checkTypes;
    try {
      assertEquals(await box.evaluateUsingInitialValues(), {
        press: 0,
        hue: 0,
        recolors: 0,
        label: "grey box",
      });
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { byId } = installDocument(`
        <div id="g1" tt-instance="${shared.instanceKey}">
          <p id="b1" tt-instance="${box.instanceKey}"></p>
          <p id="b2" tt-instance="${box.instanceKey}"></p>
        </div>
        <div id="g2" tt-instance="${shared.instanceKey}">
          <p id="b3" tt-instance="${box.instanceKey}"></p>
        </div>
        <p id="loose" tt-instance="${box.instanceKey}"></p>`);
      try {
        const load = loader(directory);
        const groups = await load(shared, "recolor");
        const boxes = await load(box, "press");
        const recolors = (id: string) =>
          boxes.recolors.forInstance(byId(id)).value;
        const all = () => ["b1", "b2", "b3", "loose"].map(recolors);
        assertEquals(all(), [0, 0, 0, 0]);
        // Recoloring one group reaches only the boxes inside it.
        groups.recolor.forInstance(byId("g1")).fire();
        assertEquals(all(), [1, 1, 0, 0]);
        // A box outside every group follows the page's group.
        groups.recolor.fire();
        assertEquals(all(), [1, 1, 0, 1]);
        // A box's own level stays its own.
        boxes.press.forInstance(byId("b1")).fire();
        assertEquals(boxes.hue.forInstance(byId("b1")).value, 90);
        assertEquals(boxes.hue.forInstance(byId("b2")).value, 0);
        // A value read follows the group around it.
        groups.tint.forInstance(byId("g2")).value = "red";
        groups.tint.value = "blue";
        assertEquals(boxes.label.forInstance(byId("b3")).value, "red box");
        assertEquals(boxes.label.forInstance(byId("b1")).value, "grey box");
        assertEquals(boxes.label.forInstance(byId("loose")).value, "blue box");
      } finally {
        uninstallDocument();
      }
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "a component roots the collections it imports with withRoot(), the one its others read by value shared by its copies",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/optional-roots-component";
    const page = new tiny.Signals(({ Trigger }) => ({ shadow: new Trigger() }));
    const shared = sharedSignals();
    const box = boxSignals(shared);
    const ColorBoxComponent = new SignalComponent(async () => {
      const { signal } = await imports(page, shared.withRoot(), box.withRoot());
      return {
        signal: [signal.press, signal.recolor],
        ColorBox: () => jsx("color-box", {}),
        RecolorButton: () => jsx("button", { type: "button" }),
      };
    });
    // Marking only the box leaves its group page-wide. The mark and inputs
    // chain either way round.
    const LoneBoxComponent = new SignalComponent(async () => {
      await imports(page, shared, box.withInputs({}).withRoot());
      return { ColorBox: () => jsx("color-box", {}) };
    });
    const InputBoxComponent = new SignalComponent(async () => {
      await imports(page, shared, box.withRoot().withInputs({}));
      return { ColorBox: () => jsx("color-box", {}) };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { component } = await imports(ColorBoxComponent);
      const [one, two] = component.instance(2);
      const linkOf = (html: unknown) =>
        /tt-link="([^"]+)"/.exec(String(html))![1];
      const links = {
        box1: linkOf(await one.ColorBox({})),
        button1: linkOf(await one.RecolorButton({})),
        box2: linkOf(await two.ColorBox({})),
      };
      // The box reads the group by value, so the group is the level the
      // copies share and the box the innermost, each copy's own; the page
      // collection, not marked, is not rooted.
      const token = (link: string, key: string) =>
        link.split(" ").find((token) => token.startsWith(`${key}=`));
      assertEquals(links.box1, links.button1);
      assertEquals(
        token(links.box1, shared.instanceKey),
        token(links.box2, shared.instanceKey),
      );
      assertEquals(
        token(links.box1, box.instanceKey) ===
          token(links.box2, box.instanceKey),
        false,
      );
      assertStringIncludes(links.box1, `${box.instanceKey}=`);
      assertEquals(token(links.box1, page.instanceKey), undefined);
      const lone = await imports(LoneBoxComponent);
      const loneLink = linkOf(await lone.component.instance().ColorBox({}));
      assertEquals(token(loneLink, shared.instanceKey), undefined);
      assertStringIncludes(loneLink, `${box.instanceKey}=`);
      const input = await imports(InputBoxComponent);
      assertStringIncludes(
        linkOf(await input.component.instance().ColorBox({})),
        `${box.instanceKey}=`,
      );
      // Exposing a signal of a collection the factory does not root warns,
      // once: every instance would share the page's one.
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      try {
        const Shared = new SignalComponent(async () => {
          const { signal } = await imports(page, box.withRoot());
          return {
            signal: [signal.shadow, signal.press],
            ColorBox: () => jsx("color-box", {}),
          };
        });
        await imports(Shared);
        await imports(Shared);
      } finally {
        console.warn = warn;
      }
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0], "exposes 'shadow'");
      assertStringIncludes(warnings[0], "withRoot()");

      // In the browser, the linked box resolves the linked group.
      const { byId } = installDocument(`
        <color-box id="box1" tt-link="${links.box1}"></color-box>
        <button id="button1" tt-link="${links.button1}"></button>
        <color-box id="box2" tt-link="${links.box2}"></color-box>
        <color-box id="box3" tt-link="${
        linkOf(await component.instance().ColorBox({}))
      }"></color-box>`);
      try {
        const load = loader(directory);
        const groups = await load(shared, "recolor");
        const boxes = await load(box, "press");
        const recolors = (id: string) =>
          boxes.recolors.forInstance(byId(id)).value;
        assertEquals([recolors("box1"), recolors("box2"), recolors("box3")], [
          0,
          0,
          0,
        ]);
        groups.recolor.forInstance(byId("button1")).fire();
        assertEquals([recolors("box1"), recolors("box2"), recolors("box3")], [
          1,
          1,
          0,
        ]);
        boxes.press.forInstance(byId("box1")).fire();
        assertEquals(boxes.hue.forInstance(byId("box2")).value, 0);
      } finally {
        uninstallDocument();
      }
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("a collection takes inputs for the page and seeds for its roots", async () => {
  reset();
  const rows = new tiny.Signals({ open: false });
  assertEquals(await rows.evaluateUsingInitialValues({ open: true }), {
    open: true,
  });
  assertEquals(await rows.evaluateUsingInitialValues({}, { open: true }), {
    open: true,
  });
  const seeded = rows.withInputs({}, { open: true });
  const html = String(
    await jsx(seeded.InstanceRoot as never, { children: jsx("li", {}) }),
  );
  assertStringIncludes(html, `tt-instance="${rows.instanceKey}"`);
  assertStringIncludes(html, "tt-seed=");
  // The collections a component roots are no longer listed before its
  // factory, and `withRoot()` is only for a component factory's imports.
  assertThrows(
    () =>
      new (SignalComponent as never as new (...args: unknown[]) => unknown)(
        [rows],
        () => ({}),
      ),
    TypeError,
    "takes only its factory",
  );
  assertThrows(
    () => new tiny.Signals(rows.withRoot(), () => ({})),
    TypeError,
    "imports another as it is",
  );
  reset();
});

Deno.test({
  name:
    "a page loads the per-root runtime once it has a root, and a handler inside one waits for it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/optional-roots-lazy";
    const rows = new tiny.Signals(({ Signal }) => ({
      open: new Signal(false),
    }));
    const globals = globalThis as Record<string, unknown>;
    const { byId, document } = installDocument(`<p id="outside"></p>`);
    // The page's runtime, as the browser's `tiny` binding is.
    globals.tiny = tinyApi;
    const host = tinyApi as unknown as {
      waitForRoots?(t: Element, type: string, s: boolean): Promise<unknown>;
    };
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const file = rows._handlerFilenames.get("open")!;
      const module = await built(directory, `${file}.js`);
      // The bundle adds what a handler waits for, and with no root, nothing.
      assertEquals(
        host.waitForRoots!(byId("outside"), "connect", true),
        undefined,
      );
      module.open.value = true;
      assertEquals(module.open.value, true);

      // A root arrives; a handler there given the signal waits for the
      // runtime, then acts on the root's own copy.
      document.body.insertAdjacentHTML(
        "beforeend",
        `<li tt-instance="${rows.instanceKey}"><button id="b"></button></li>`,
      );
      const handlers = (globals.handlers ??= {}) as Record<string, unknown>;
      handlers[file] = module;
      handlers.lazy_test = {
        toggle(_event: Event, open: { value: boolean }) {
          open.value = !open.value;
        },
      };
      byId("b").setAttribute(
        "tt-handler-click",
        `lazy_test.toggle(${file}.open)`,
      );
      runHandler(byId("b"), new Event("click"));
      await host.waitForRoots!(byId("b"), "connect", true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Loaded, nothing waits any more.
      assertEquals(host.waitForRoots!(byId("b"), "connect", true), undefined);
      assertEquals(module.open.forInstance(byId("b")).value, true);
      // The page's own is untouched.
      runHandler(byId("outside"), new Event("click"));
      assertEquals(module.open.value, true);
      assertStrictEquals(module.open.forInstance(byId("outside")), module.open);
    } finally {
      delete globals.tiny;
      delete host.waitForRoots;
      delete (globals.handlers as Record<string, unknown> | undefined)
        ?.lazy_test;
      uninstallDocument();
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});
