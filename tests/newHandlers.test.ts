import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { pathToFileURL } from "node:url";
import { compileHandlerBundle } from "../handlerNamespace.ts";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Handlers,
  imports,
  registeredClientTools,
  Signals,
  Styles,
  Templates,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import type { JSX } from "../jsx-runtime.ts";
import { handlerReferenceAttributes } from "../eventAttributes.ts";

/** Compile a single-handler bundle; `dependencies` maps key -> [path, export]. */
function compileOne(
  source: string,
  dependencies: [string, string, string?][] = [],
  name = "consumer",
) {
  return compileHandlerBundle({
    functions: new Map([[name, source]]),
    dependencies: new Map(
      dependencies.map(([key, path, exportName]) => [key, {
        path,
        exportName: exportName ??
          (key.startsWith("signal:") ? key.slice(7) : key),
      }]),
    ),
  });
}

const loadCode = (code: string) =>
  import(`data:text/javascript,${encodeURIComponent(code)}`);

Deno.test({
  name:
    "signal namespace retains only used dependencies and stays separate from fn",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    try {
      const result = await compileOne(
        "function () { return signal.count.value + fn.count(); }",
        [
          ["signal:count", "./signals_a.js"],
          ["signal:unused", "./signals_a.js"],
          ["count", "./handlers_b.js"],
        ],
      );
      assertEquals(result.dependencies.sort(), ["count", "signal:count"]);
      assertStringIncludes(result.code, "signal.count.value");
      assertStringIncludes(result.code, "fn.count()");
      assertStringIncludes(result.code, 'from "./signals_a.js"');
      assertEquals(result.code.includes("unused"), false);
      // Imports keep their names. `fn.count` is also callable as bare `count`,
      // so the clashing signal import is the one aliased.
      assertStringIncludes(
        result.code,
        'import { count as count2 } from "./signals_a.js"',
      );
      assertStringIncludes(
        result.code,
        'import { count } from "./handlers_b.js"',
      );
      assertStringIncludes(
        result.code,
        "const signal = { get count() { return count2(); } }",
      );
      assertStringIncludes(result.code, "export function consumer()");
      const grouped = await compileOne(
        // Names inside strings, templates and comments do not force aliases.
        "function () { /* one */ return `one ${signal.one.value}` + 'two' + signal.two.value; }",
        [["signal:one", "./signals_a.js"], ["signal:two", "./signals_a.js"]],
      );
      assertStringIncludes(
        grouped.code,
        'import { one, two } from "./signals_a.js"',
      );
      const collision = await compileOne(
        "function () { return signal.count.value + fn.signal(); }",
        [["signal:count", "./signals_a.js"], ["signal", "./handlers_b.js"]],
        "signal",
      );
      assertEquals(collision.dependencies.sort(), ["signal", "signal:count"]);
      assertStringIncludes(collision.code, "signal as signal2");
      assertStringIncludes(collision.code, "as signal }");
      const numbered = await compileOne(
        "function () { const dependency = 1; return signal['not-valid'].value + signal.fn.value + dependency; }",
        [
          ["signal:not-valid", "./signals_a.js"],
          ["signal:fn", "./signals_a.js"],
        ],
      );
      assertStringIncludes(
        numbered.code,
        'import { "not-valid" as dependency2, fn as fn2 } from "./signals_a.js"',
      );
    } finally {
      (await getEsbuild()).stop();
    }
  },
});

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

Deno.test({
  name:
    "Signals emit one bundle per instance with shared computed dependencies",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signals";
    const create = () =>
      new Signals(import.meta.url, ({ Signal, Computed }) => {
        const count = new Signal(1);
        const empty = new Signal();
        const doubled = new Computed(() => count.value * 2, [count]);
        const text = new Signal("initial");
        return { count, empty, doubled, text };
      });
    const first = create();
    const second = create();
    const consumer = new Handlers(import.meta.url, async () => {
      const { signal } = await imports(first);
      return {
        read: function () {
          return [signal.count, signal.doubled, signal.empty];
        },
      };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const load = (filename: string) =>
        import(
          pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${filename}.js`)
            .href
        );
      // One bundle per Signals instance, plus the runtime modules they use.
      assertEquals(
        new Set(
          ["count", "empty", "doubled", "text"].map((name) =>
            first._handlerFilenames.get(name)
          ),
        ).size,
        1,
      );
      // Package bundles registered by other test files are built too.
      const built = [...Deno.readDirSync(`${directory}/handlers`)].map((
        entry,
      ) => entry.name).filter((name) =>
        name.startsWith("newHandlers_") || name.startsWith("tt-")
      ).sort();
      assertEquals(
        built,
        [
          `${consumer._handlerFilenames.get("read")}.js`,
          `${first._handlerFilenames.get("count")}.js`,
          `${second._handlerFilenames.get("count")}.js`,
          built.find((name) => name.startsWith("tt-signal_"))!,
          built.find((name) => name.startsWith("tt-computed_"))!,
        ].sort(),
      );
      const signalCode = await Deno.readTextFile(
        `${directory}/handlers/${first._handlerFilenames.get("count")}.js`,
      );
      // Only the runtime modules the factory's parameter names are imported.
      assertStringIncludes(
        signalCode,
        'import { SignalInstance as Signal } from "./tt-signal_',
      );
      assertStringIncludes(
        signalCode,
        'import { ComputedInstance as Computed } from "./tt-computed_',
      );
      assertEquals(signalCode.includes("tt-trigger_"), false);
      assertEquals(signalCode.includes("tt-instance_"), false);
      assertStringIncludes(
        signalCode,
        "const signals = (() => {",
      );
      // Factory locals keep their names even though they match exports.
      assertStringIncludes(signalCode, "const count = new Signal(1)");
      assertStringIncludes(signalCode, "export function count(event)");
      assertStringIncludes(
        signalCode,
        "signals.count.handleEvent(this, event)",
      );
      assertEquals(signalCode.includes("stored"), false);
      const module = await load(consumer._handlerFilenames.get("read")!);
      const [count, doubled, empty] = module.read();
      assertEquals(count.value, 1);
      assertEquals(doubled.value, 2);
      assertEquals(empty.value, null);
      // Signals without a name are named after their keys.
      assertEquals(
        [count.name, doubled.name, empty.name],
        ["count", "doubled", "empty"],
      );
      assertEquals(module.read()[0], count);
      const target = new EventTarget();
      const values: number[] = [];
      target.addEventListener(
        "signal",
        (event) =>
          values.push(
            (event as Event & { signal: { value: number } }).signal.value,
          ),
      );
      doubled.subscribe(target);
      doubled.subscribe(target);
      count.value = 2;
      count.value = 2;
      assertEquals(doubled.value, 4);
      assertEquals(values, [4]);
      assertThrows(
        () => {
          doubled.value = 8;
        },
        TypeError,
        "read-only",
      );
      const other = await load(second._handlerFilenames.get("count")!);
      assertEquals(other.count().value, 1);
      assertNotEquals(other.count(), count);
      const textModule = await load(first._handlerFilenames.get("text")!);
      const input = Object.assign(new EventTarget(), {
        value: "typed",
        dataset: {},
      });
      input.addEventListener(
        "input",
        (event) => textModule.text.call(input, event),
      );
      input.dispatchEvent(new Event("input"));
      assertEquals(textModule.text().value, "typed");
      const subscriber = Object.assign(new EventTarget(), {
        abortController: new AbortController(),
      });
      let notifications = 0;
      subscriber.addEventListener("signal", () => notifications++);
      // A load subscribes once and sends nothing until a change.
      textModule.text.call(subscriber, new Event("load"));
      textModule.text.call(subscriber, new Event("load"));
      assertEquals(notifications, 0);
      textModule.text().value = "first";
      assertEquals(notifications, 1);
      subscriber.abortController.abort();
      textModule.text().value = "second";
      subscriber.dispatchEvent(new Event("tt-fire-signals"));
      assertEquals(notifications, 1);
      subscriber.abortController = new AbortController();
      textModule.text.call(subscriber, new Event("load"));
      assertEquals(notifications, 1);
      textModule.text().value = "third";
      assertEquals(notifications, 2);
      const references = await imports(first);
      assertEquals(typeof references.signal.count, "object");
      assertThrows(
        () => references.signal.count.value,
        Error,
        "only a handler reference while rendering",
      );
      assertEquals((references.fn as Record<string, unknown>).count, undefined);
      assertEquals(
        handlerReferenceAttributes("onInput", references.signal.text),
        {
          oninput: "tiny.runHandler(this,event)",
          "tt-handler-input": `${first._handlerFilenames.get("text")}.text`,
        },
      );
      const checkTypes = () => {
        const value: number = references.signal.count.value;
        // @ts-expect-error Signals are not ordinary fn handlers.
        references.fn.count();
        // @ts-expect-error Computed values cannot be assigned.
        references.signal.doubled.value = 3;
        // @ts-expect-error Signal factories cannot return handlers.
        new Signals(import.meta.url, () => ({ bad: () => 1 }));
        return value;
      };
      void checkTypes;
      const checkMixedImports = async () => {
        const styles = new Styles(import.meta.url, { section: "color: red;" });
        const { fn, signal, styled } = await imports(consumer, styles, first);
        const section: string = styled.section;
        const count: number = signal.count.value;
        fn.read();
        // @ts-expect-error Unknown styles must not be exposed.
        styled.missing;
        return { section, count };
      };
      void checkMixedImports;
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Signals unpack the toolkit for any factory shape",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-shapes";
    const plain = new Signals(
      import.meta.url,
      (tools) => ({ total: new tools.Signal(2) }),
    );
    const expression = new Signals(
      import.meta.url,
      function ({ Signal }) {
        return { label: new Signal("text") };
      },
    );
    // A signal named like the toolkit falls back to calling the factory.
    const clashing = new Signals(
      import.meta.url,
      ({ Signal }) => ({ Signal: new Signal(3) }),
    );
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const load = async (
        tools: {
          _handlerFilenames: ReadonlyMap<string, string>;
        },
      ) => {
        const filename = [...tools._handlerFilenames.values()][0];
        const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
        return {
          code: await Deno.readTextFile(path),
          module: await import(pathToFileURL(path).href),
        };
      };
      const plainBundle = await load(plain);
      assertStringIncludes(
        plainBundle.code,
        "const tools = { Signal: __tiny_Signal,",
      );
      assertStringIncludes(plainBundle.code, "const signals = (() =>");
      assertEquals(plainBundle.module.total().value, 2);
      const expressionBundle = await load(expression);
      assertStringIncludes(
        expressionBundle.code,
        'import { SignalInstance as Signal } from "./tt-signal_',
      );
      assertStringIncludes(
        expressionBundle.code,
        "const signals = (function()",
      );
      assertEquals(expressionBundle.module.label().value, "text");
      const clashingBundle = await load(clashing);
      assertStringIncludes(
        clashingBundle.code,
        "const signals = defineSignals({ Signal: __tiny_Signal,",
      );
      assertEquals(clashingBundle.module.Signal().value, 3);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Signals bundles scope perInstance signals to the collection's roots",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/instance-signals";
    const layers = new Signals(
      import.meta.url,
      ({ Signal, Computed, perInstance }) => {
        const layer = perInstance(() => ({ material: new Signal("bulk") }));
        const materials = new Computed(
          () => layer.material.all.value.join(", "),
          [layer.material.all],
        );
        return { ...layer, materials };
      },
    );
    const { parseHTML } = await import("linkedom");
    // The second root also roots another collection.
    const window = parseHTML(
      `<html><body><p tt-instance="${layers.instanceKey}"><i id="a"></i></p><p tt-instance="other ${layers.instanceKey}"><i id="b"></i></p></body></html>`,
    );
    Object.assign(globalThis, {
      document: window.document,
      MutationObserver: window.MutationObserver,
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = [...layers._handlerFilenames.values()][0];
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const module = await import(pathToFileURL(path).href);
      const a = window.document.getElementById("a");
      // `onChange={signal.material}` on an element inside the first root.
      module.material.call(a, {
        type: "change",
        target: { value: "flow", dataset: {}, name: "" },
      });
      assertEquals(module.materials().value, "flow");
      // The second root counts once something inside it resolves a signal.
      module.material().forInstance(window.document.getElementById("b"));
      assertEquals(module.materials().value, "flow, bulk");
      // Read from a handler, the accessor is the per-instance handle.
      assertEquals(module.material().forInstance(a).value, "flow");
    } finally {
      const globals = globalThis as Record<string, unknown>;
      delete globals.document;
      delete globals.MutationObserver;
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Signal references offer update, toggle and fire for their kind",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-actions";
    const actions = new Signals(
      import.meta.url,
      ({ Signal, Computed, Trigger, perInstance }) => {
        const size = new Signal(76);
        const italic = new Signal(false);
        const reset = new Trigger();
        const doubled = new Computed(() => size.value * 2);
        const row = perInstance(() => ({ open: new Signal(false) }));
        return { size, italic, reset, doubled, ...row };
      },
    );
    const consumer = new Handlers(import.meta.url, async () => {
      const { signal } = await imports(actions);
      return {
        names: function () {
          return Object.keys(signal);
        },
      };
    });
    const { parseHTML } = await import("linkedom");
    const window = parseHTML(
      `<html><body><p tt-instance="${actions.instanceKey}"><i id="a"></i></p></body></html>`,
    );
    Object.assign(globalThis, { document: window.document });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = actions._handlerFilenames.get("size")!;
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const code = await Deno.readTextFile(path);
      const module = await import(pathToFileURL(path).href);
      // Each kind exports only the actions it offers.
      assertEquals(
        Object.keys(module).filter((name) => name.includes("$")).sort(),
        [
          "italic$toggle",
          "italic$update",
          "open$toggle",
          "open$update",
          "reset$fire",
          "size$update",
        ],
      );
      assertStringIncludes(code, "signals.size.update(this, event)");
      const element = new EventTarget();
      module.size$update.call(element, {
        type: "input",
        target: { value: "120", dataset: {}, name: "size" },
      });
      assertEquals(module.size().value, 120);
      // A toggle flips the value whatever the event.
      module.italic$toggle.call(element, new Event("click"));
      assertEquals(module.italic().value, true);
      module.italic$update.call(element, {
        type: "change",
        target: { type: "checkbox", checked: false, value: "on", dataset: {} },
      });
      assertEquals(module.italic().value, false);
      const fired = module.reset().value;
      module.reset$fire.call(element, new Event("click"));
      assertEquals(module.reset().value, fired + 1);
      // Per-instance actions act on the instance enclosing the element.
      const a = window.document.getElementById("a");
      module.open$toggle.call(a, new Event("click"));
      assertEquals(module.open().forInstance(a).value, true);
      // Handlers see the signals, not their action handlers.
      const consumerPath = `${Deno.cwd()}/${directory}/handlers/${
        consumer._handlerFilenames.get("names")
      }.js`;
      assertEquals(
        (await import(pathToFileURL(consumerPath).href)).names().sort(),
        ["doubled", "italic", "open", "reset", "size"],
      );
      const { signal } = await imports(actions);
      assertEquals(
        handlerReferenceAttributes("onInput", signal.size.update),
        {
          oninput: "tiny.runHandler(this,event)",
          "tt-handler-input": `${filename}.size$update`,
        },
      );
      assertEquals(
        handlerReferenceAttributes("onClick", signal.reset.fire)?.[
          "tt-handler-click"
        ],
        `${filename}.reset$fire`,
      );
      assertThrows(
        // @ts-expect-error A number cannot be toggled.
        () => signal.size.toggle,
        TypeError,
        "signal.size.toggle is only available on a Signal holding a boolean",
      );
      assertThrows(
        // @ts-expect-error A computed is read-only.
        () => signal.doubled.update,
        TypeError,
        "signal.doubled.update is only available on a writable Signal",
      );
      const checkTypes = () => {
        const handlers: [
          JSX.IntrinsicElements["input"],
          JSX.IntrinsicElements["button"],
        ] = [
          { onInput: signal.size.update, onChange: signal.italic.update },
          {
            onClick: [
              signal.italic.toggle,
              signal.open.toggle,
              signal.reset.fire,
            ],
          },
        ];
        // @ts-expect-error A trigger has no value to update.
        signal.reset.update;
        // @ts-expect-error Only triggers fire.
        signal.italic.fire;
        return handlers;
      };
      void checkTypes;
    } finally {
      delete (globalThis as Record<string, unknown>).document;
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "Collections build without a source file, named after their first name and kind",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/unsourced";
    const sourced = new Handlers(import.meta.url, { resetType() {} });
    const handlers = new Handlers({
      "reset-type": function () {},
      other: function () {},
    });
    const styles = new Styles({ button: "color: red;", link: "color: blue;" });
    const helpers = new Handlers({
      double(value: number) {
        return value * 2;
      },
    });
    const signals = new Signals(async () => {
      const { fn } = await imports(helpers);
      return ({ Signal, Computed }) => {
        const size = new Signal(2);
        return { size, doubled: new Computed(() => fn.double(size.value)) };
      };
    });
    const consumer = new Handlers(async () => {
      const { fn, signal } = await imports(helpers, signals);
      return {
        read: function () {
          return fn.double(signal.doubled.value);
        },
      };
    });
    const templates = new Templates({ row: () => "row" });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const load = (filename: string) =>
        import(
          pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${filename}.js`)
            .href
        );
      assertEquals(
        (await load(consumer._handlerFilenames.get("read")!)).read(),
        8,
      );
      for (
        const [filename, pattern] of [
          [consumer._handlerFilenames.get("read")!, /^read_handler_\w+$/],
          [signals._handlerFilenames.get("doubled")!, /^size_signal_\w+$/],
          [templates._handlerFilenames.get("row")!, /^row_template_\w+$/],
        ] as const
      ) {
        assertEquals(pattern.test(filename), true, filename);
      }
      // A source file still names the bundle.
      assertEquals(
        /^newHandlers_test_\w+$/.test(
          sourced._handlerFilenames.get("resetType")!,
        ),
        true,
      );
      assertEquals(
        /^reset_type_handler_\w+$/.test(
          handlers._handlerFilenames.get("other")!,
        ),
        true,
      );
      assertEquals(
        /^button_style_\w+$/.test(styles._styleFilenames.get("link")!),
        true,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("Signals reject non-signal outputs and definition-time value access", async () => {
  reset();
  try {
    const invalid = new Signals(
      import.meta.url,
      (() => ({ invalid: () => 1 })) as never,
    );
    await assertRejects(
      () => invalid.ensureDefined(),
      TypeError,
      "Signal or Computed",
    );
    const asynchronous = new Signals(
      import.meta.url,
      (() => Promise.resolve({})) as never,
    );
    await assertRejects(
      () => asynchronous.ensureDefined(),
      TypeError,
      "synchronously",
    );
  } finally {
    reset();
  }
});

Deno.test("Handlers.run executes original functions without building", async () => {
  reset();
  const collection = new Handlers(import.meta.url, {
    writeTextContent: function (value: string) {
      return value === "" ? "No text entered." : `Entered text: ${value}`;
    },
    withReceiver: function (this: { prefix: string }, value: string) {
      return this.prefix + value;
    },
    asyncValue: async function (value: number) {
      await Promise.resolve();
      return value + 1;
    },
    fail: function () {
      throw new Error("handler failed");
    },
  });
  try {
    collection.ensureBuilt = () => {
      throw new Error("Server calls must not build client assets");
    };
    const output: string = collection.run.writeTextContent("placeholder text");
    assertEquals(output, "Entered text: placeholder text");
    assertEquals(collection.run.writeTextContent(""), "No text entered.");
    assertEquals(
      collection.run.withReceiver.call({ prefix: "Entered: " }, "text"),
      "Entered: text",
    );
    const pending: Promise<number> = collection.run.asyncValue(2);
    assertEquals(await pending, 3);
    assertThrows(() => collection.run.fail(), Error, "handler failed");
    assertEquals(
      collection.run.writeTextContent,
      collection._handlerDefinitions.get("writeTextContent")!.fn,
    );
    const checkTypes = () => {
      // @ts-expect-error Server argument types are preserved.
      collection.run.writeTextContent(123);
      // @ts-expect-error Unknown handlers are not exposed.
      collection.run.missing();
    };
    void checkTypes;
  } finally {
    reset();
  }
});

Deno.test("Handlers.run requires factory definitions to be ready", async () => {
  reset();
  const collection = new Handlers(import.meta.url, async () => {
    await Promise.resolve();
    return {
      format: function (value: string) {
        return `Entered text: ${value}`;
      },
    };
  });
  try {
    assertThrows(() => collection.run, Error, "Await tools.ensureDefined()");
    await collection.ensureDefined();
    assertEquals(collection.run.format("text"), "Entered text: text");
    assertThrows(
      () => new Handlers(import.meta.url, { run: function () {} }),
      Error,
      "reserved",
    );
  } finally {
    reset();
  }
});

Deno.test({
  name:
    "Handlers factory collects private imports without executing handler bodies",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    let definitions = 0;
    const dependency = new Handlers(import.meta.url, {
      used: function (value: number) {
        return value + 1;
      },
      unused: function () {
        throw new Error("Must not execute");
      },
    });
    const collection = new Handlers(import.meta.url, async () => {
      definitions++;
      const { fn } = await imports(dependency);
      const checkTypes = () => {
        // @ts-expect-error imported argument types are preserved
        fn.used("wrong");
      };
      void checkTypes;
      return {
        consumer: function (value: number) {
          return fn.used(value);
        },
      };
    });
    try {
      await Promise.all([
        collection.ensureDefined(),
        collection.ensureDefined(),
      ]);
      assertEquals(definitions, 1);
      assertEquals(collection.run.consumer(2), 3);
      assertEquals([...collection._handlerFilenames.keys()], ["consumer"]);
      const consumer = collection._handlerDefinitions.get("consumer")!;
      const code = await consumer.buildCode();
      assertStringIncludes(
        code,
        `import { used } from "./${
          dependency._handlerFilenames.get("used")
        }.js"`,
      );
      assertEquals(code.includes("unused"), false);
      // @ts-expect-error imported handlers remain private through run
      collection.run.used;
    } finally {
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "handler bundles retain only statically used external handlers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    try {
      const dependencies: [string, string][] = [
        ["used", "./leaf_hash.js"],
        ["unused", "./leaf_hash.js"],
      ];
      for (
        const body of [
          "function(event) { return fn.used(event); }",
          "function(event) { return fn.used.call(this, event); }",
          "function(event) { return fn['used'](event); }",
          "consumer(event) { return fn.used(event); }",
          "consumer(event) { return [event].map(value => fn.used(value)); }",
          "function(event) { return used(event); }",
        ]
      ) {
        const result = await compileOne(body, dependencies);
        assertEquals(result.dependencies, ["used"]);
        assertStringIncludes(
          result.code,
          'import { used } from "./leaf_hash.js"',
        );
        assertEquals(result.code.includes("unused"), false);
        if (body.includes("fn.")) {
          assertStringIncludes(result.code, "const fn = { used }");
          assertStringIncludes(result.code, "fn.used");
        }
        if (body.includes("fn.used.call")) {
          assertStringIncludes(result.code, "fn.used.call(this, event)");
        }
        assertEquals(result.code.includes("globalThis.handlers"), false);
        assertStringIncludes(result.code, "export ");
        assertStringIncludes(result.code, "consumer(");
      }
      const dynamic = await compileOne(
        "function(name, event) { return fn[name](event); }",
        dependencies,
      );
      assertEquals(dynamic.dependencies.sort(), ["unused", "used"]);
      assertStringIncludes(dynamic.code, "fn[name](event)");
      const dependencyUrl =
        "data:text/javascript,export default value => value + 1";
      for (
        const [source, expected, declaration, name] of [
          [
            "async function(value) { return value + 1; }",
            42,
            "async function",
            "consumer",
          ],
          [
            "function*(value) { yield value + 1; }",
            42,
            "function*",
            "consumer",
          ],
          [
            "function recurse(value) { return value ? recurse(value - 1) + 1 : 0; }",
            41,
            "function recurse",
            "consumer",
          ],
          ["value => value + 1", 42, "=>", "consumer"],
          ["function(value) { return fn.used(value); }", 42, "fn.used", "fn"],
        ] as const
      ) {
        const result = await compileOne(
          source,
          [["used", dependencyUrl, "default"]],
          name,
        );
        assertStringIncludes(result.code, declaration);
        const module = await loadCode(result.code);
        const value = await module[name](41);
        assertEquals(
          source.startsWith("function*") ? value.next().value : value,
          expected,
        );
      }
      const registry = globalThis as typeof globalThis & {
        handlers?: Record<string, unknown>;
      };
      const previousHandlers = registry.handlers;
      try {
        delete registry.handlers;
        for (
          const key of [
            "used",
            "fn",
            "_handler",
            "default",
            "some-handler",
            "__proto__",
          ]
        ) {
          const result = await compileOne(
            `function(used) { return fn[${JSON.stringify(key)}](used); }`,
            [[key, dependencyUrl, "default"]],
          );
          assertEquals(result.dependencies, [key]);
          const module = await loadCode(result.code);
          assertEquals(module.consumer(41), 42);
          assertEquals(registry.handlers, undefined);
        }
      } finally {
        if (previousHandlers === undefined) {
          delete registry.handlers;
        } else {
          registry.handlers = previousHandlers;
        }
      }
      for (
        const body of [
          "function(fn) { return fn.used(); }",
          "function() { return 'fn.used'; }",
          "function() { return 1; }",
        ]
      ) {
        const result = await compileOne(body, dependencies);
        assertEquals(result.dependencies, []);
      }
      await assertRejects(
        () => compileOne("function() { fn.missing(); }", dependencies),
        Error,
        "missing",
      );
      const siblings = await compileHandlerBundle({
        functions: new Map([
          ["double", "function(value) { return value * 2; }"],
          ["quadruple", "function(value) { return double(double(value)); }"],
          ["not-an-identifier", "function() { return 'ok'; }"],
        ]),
        dependencies: new Map(),
      });
      const siblingModule = await loadCode(siblings.code);
      assertEquals(siblingModule.quadruple(3), 12);
      assertEquals(siblingModule["not-an-identifier"](), "ok");
    } finally {
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Handlers rejects duplicate imports, definition calls, and cycles",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const first = new Handlers(import.meta.url, {
      shared: function () {
        return 1;
      },
    });
    const second = new Handlers(import.meta.url, {
      shared: function () {
        return 2;
      },
    });
    const duplicate = new Handlers(import.meta.url, async () => {
      await imports(first, second);
      return {};
    });
    await assertRejects(
      () => duplicate.ensureDefined(),
      Error,
      "Duplicate imported handler",
    );
    let attempts = 0;
    const invalidCall = new Handlers(import.meta.url, async () => {
      attempts++;
      const { fn } = await imports(first);
      fn.shared();
      return {};
    });
    await assertRejects(
      () => invalidCall.ensureDefined(),
      Error,
      "cannot be called",
    );
    await assertRejects(
      () => invalidCall.ensureDefined(),
      Error,
      "cannot be called",
    );
    assertEquals(attempts, 1);
    const cycleA = new Handlers(
      import.meta.url,
      async (): Promise<Record<never, never>> => {
        await imports(cycleB);
        return {};
      },
    );
    const cycleB = new Handlers(
      import.meta.url,
      async (): Promise<Record<never, never>> => {
        await imports(cycleA);
        return {};
      },
    );
    await assertRejects(
      () => Promise.all([cycleA.ensureDefined(), cycleB.ensureDefined()]),
      Error,
      "Circular handler definition",
    );
    assertThrows(() => cycleA.run, Error, "not ready");
    reset();
  },
});

Deno.test({
  name: "Handlers keeps concurrent same-file collections isolated",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const first = new Handlers(import.meta.url, () => ({
      shared: function () {
        return "first";
      },
    }));
    const second = new Handlers(import.meta.url, () => ({
      shared: function () {
        return "second";
      },
    }));
    const left = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(first);
      await Promise.resolve();
      return {
        consumer: function () {
          return fn.shared();
        },
      };
    });
    const right = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(second);
      return {
        consumer: function () {
          return fn.shared();
        },
      };
    });
    try {
      await Promise.all([
        left.ensureDefined(),
        right.ensureDefined(),
      ]);
      const leftCode = await left._handlerDefinitions.get("consumer")!
        .buildCode();
      const rightCode = await right._handlerDefinitions.get("consumer")!
        .buildCode();
      assertStringIncludes(leftCode, first._handlerFilenames.get("shared")!);
      assertEquals(
        leftCode.includes(second._handlerFilenames.get("shared")!),
        false,
      );
      assertStringIncludes(rightCode, second._handlerFilenames.get("shared")!);
      assertEquals(
        rightCode.includes(first._handlerFilenames.get("shared")!),
        false,
      );
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Handlers filenames do not depend on asynchronous completion order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const buildPair = async (reverse: boolean) => {
      reset();
      const first = new Handlers(
        import.meta.url,
        () => ({
          shared: function () {
            return "first";
          },
        }),
      );
      const second = new Handlers(
        import.meta.url,
        () => ({
          shared: function () {
            return "second";
          },
        }),
      );
      const left = new Handlers(import.meta.url, async () => {
        const { fn } = await imports(first);
        return {
          consumer: function () {
            return fn.shared();
          },
        };
      });
      const right = new Handlers(import.meta.url, async () => {
        const { fn } = await imports(second);
        return {
          consumer: function () {
            return fn.shared();
          },
        };
      });
      for (const tool of reverse ? [right, left] : [left, right]) {
        await tool.ensureDefined();
      }
      return [
        left._handlerFilenames.get("consumer"),
        right._handlerFilenames.get("consumer"),
      ];
    };
    try {
      assertEquals(await buildPair(false), await buildPair(true));
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Handlers initializes in production and preserves JSX handler types",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const previousTrust = cache.trustCache;
    const mutableCache = cache as { trustCache: boolean };
    mutableCache.trustCache = true;
    const collection = new Handlers(import.meta.url, () => ({
      click: function (this: HTMLButtonElement, event: MouseEvent) {
        return event.button;
      },
      submit: function (this: HTMLFormElement, event: SubmitEvent) {
        return event.submitter;
      },
    }));
    try {
      const { fn } = await imports(collection);
      const click: NonNullable<JSX.IntrinsicElements["button"]["onClick"]> =
        fn.click;
      const submit: NonNullable<JSX.IntrinsicElements["form"]["onSubmit"]> =
        fn.submit;
      // @ts-expect-error submit handlers cannot be used as button click handlers
      const incorrect: NonNullable<JSX.IntrinsicElements["button"]["onClick"]> =
        fn.submit;
      assertEquals(typeof click, "object");
      assertEquals(typeof submit, "object");
      assertEquals(typeof incorrect, "object");
      assertEquals(collection._handlerFilenames.size, 2);
    } finally {
      mutableCache.trustCache = previousTrust;
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "Handlers lazy rebuild renames every bundle that imports a changed bundle",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/new-handler-rebuild";
    const handlerDir = `${directory}/handlers`;
    const leaf = new Handlers(import.meta.url, () => ({
      used: function () {
        return 1;
      },
      unused: function () {
        return 100;
      },
    }));
    const middle = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(leaf);
      return {
        forward: function () {
          return fn.used();
        },
      };
    });
    const root = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(middle);
      return {
        consumer: function () {
          return fn.forward();
        },
      };
    });
    const unrelated = new Handlers(import.meta.url, () => ({
      standalone: function () {
        return "unchanged";
      },
    }));
    const rebuild = async () => {
      cache.beginChangeDetectionPass();
      for (const tools of [root, unrelated]) {
        for (const impl of tools._handlerDefinitions.values()) {
          await impl.bundle.ensureWritten(handlerDir);
        }
      }
      cache.commitPendingSourceMtimes();
    };
    try {
      await buildScriptFiles({ publicDir: directory });
      const initialRoot = root._handlerFilenames.get("consumer")!;
      const initialUnrelated = unrelated._handlerFilenames.get("standalone")!;
      await rebuild();
      assertEquals(root._handlerFilenames.get("consumer"), initialRoot);

      // Any change to the leaf bundle changes its file, so every bundle
      // importing it (directly or not) needs a new URL.
      leaf._handlerDefinitions.get("unused")!.fn = function () {
        return 200;
      };
      await rebuild();
      const changedRoot = root._handlerFilenames.get("consumer")!;
      assertNotEquals(changedRoot, initialRoot);
      assertEquals(
        unrelated._handlerFilenames.get("standalone"),
        initialUnrelated,
      );
      assertStringIncludes(
        await Deno.readTextFile(`${handlerDir}/${changedRoot}.js`),
        middle._handlerFilenames.get("forward")!,
      );
      assertStringIncludes(
        await Deno.readTextFile(
          `${handlerDir}/${middle._handlerFilenames.get("forward")}.js`,
        ),
        leaf._handlerFilenames.get("used")!,
      );
      await assertRejects(
        () => Deno.stat(`${handlerDir}/${initialRoot}.js`),
        Deno.errors.NotFound,
      );
      await rebuild();
      assertEquals(root._handlerFilenames.get("consumer"), changedRoot);
    } finally {
      await Deno.remove(directory, { recursive: true });
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "Handlers fresh build awaits nested factories and emits executable modules",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/new-handlers";
    const leaf = new Handlers(import.meta.url, () => ({
      increment: function (this: { offset: number }, value: number) {
        return this.offset + value;
      },
      unused: function () {
        throw new Error("unused");
      },
    }));
    const middle = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(leaf);
      return {
        forward: function (this: { offset: number }, value: number) {
          return fn.increment.call(this, value);
        },
      };
    });
    const root = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(middle);
      return {
        consumer: function (this: { offset: number }, value: number) {
          return fn.forward.call(this, value);
        },
      };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = root._handlerFilenames.get("consumer")!;
      const module = await import(
        pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${filename}.js`).href
      );
      assertEquals(module.consumer.call({ offset: 10 }, 4), 14);
      const browserGlobals = globalThis as unknown as {
        handlers?: Record<string, Record<string, unknown>>;
      };
      // Evaluating a bundle registers its handlers for synchronous dispatch.
      assertEquals(
        browserGlobals.handlers?.[filename]?.consumer,
        module.consumer,
      );
      assertEquals([...root._handlerFilenames.keys()], ["consumer"]);
    } finally {
      Reflect.deleteProperty(globalThis, "handlers");
      await Deno.remove(directory, { recursive: true });
      reset();
      (await getEsbuild()).stop();
    }
  },
});
