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
import type { Signal } from "../signals.ts";
import { handlerReferenceAttributes } from "../eventAttributes.ts";
import { runHandler } from "../honoFactory.tsx";
import {
  recordingSubscribers,
  signalMutators,
} from "./helpers/signalRuntime.ts";
import { signalActionTools, signalSyncTools } from "../handlers/signals.ts";

/** The bundle a `fn.signals` handler lives in, as its references name it. */
const mutatorBundle = (mutator: string): string =>
  (signalSyncTools._handlerFilenames.get(mutator) ??
    signalActionTools._handlerFilenames.get(mutator))!;

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
        "const signal = { get count() { return count2; } }",
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
      // The signals themselves are exported and registered.
      assertStringIncludes(
        signalCode,
        "export const { count, empty, doubled, text } = signals;",
      );
      assertStringIncludes(signalCode, `] = signals;`);
      assertEquals(signalCode.includes("export function"), false);
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
      const values: number[] = [];
      doubled.addEventListener(
        "signal",
        (event: Event) =>
          values.push(
            (event as Event & { signal: { value: number } }).signal.value,
          ),
      );
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
      assertEquals(other.count.value, 1);
      assertNotEquals(other.count, count);
      const textModule = await load(first._handlerFilenames.get("text")!);
      const input = Object.assign(new EventTarget(), {
        value: "typed",
        dataset: {},
      });
      // As `onInput={fn.signals.update(signal.text)}` runs it.
      const { update } = signalMutators();
      input.addEventListener(
        "input",
        (event) => update.call(input, event, textModule.text),
      );
      input.dispatchEvent(new Event("input"));
      assertEquals(textModule.text.value, "typed");
      const subscribers = recordingSubscribers();
      try {
        const { element: subscriber, seen } = subscribers.subscriber();
        // Subscribing registers once and sends nothing until a change.
        textModule.text.subscribe(subscriber);
        textModule.text.subscribe(subscriber);
        assertEquals(seen.length, 0);
        textModule.text.value = "first";
        assertEquals(seen.length, 1);
        subscriber.abortController.abort();
        textModule.text.value = "second";
        subscriber.dispatchEvent(new Event("tt-fire-signals"));
        assertEquals(seen.length, 1);
        subscriber.abortController = new AbortController();
        textModule.text.subscribe(subscriber);
        assertEquals(seen.length, 1);
        textModule.text.value = "third";
        assertEquals(seen, ["first", "third"]);
      } finally {
        subscribers.restore();
      }
      const references = await imports(first);
      assertEquals(typeof references.signal.count, "object");
      assertThrows(
        () => references.signal.count.value,
        Error,
        "only a handler reference while rendering",
      );
      assertEquals((references.fn as Record<string, unknown>).count, undefined);
      // A signal is not a handler on its own: `fn.signals.update` writes it.
      assertThrows(
        () => handlerReferenceAttributes("onInput", references.signal.text),
        TypeError,
        "onInput={signal.text} is not a handler",
      );
      assertEquals(
        handlerReferenceAttributes(
          "onInput",
          references.fn.signals.update(references.signal.text),
        ),
        {
          oninput: "tiny.runHandler(this,event)",
          "tt-handler-input": `${mutatorBundle("update")}.update(${
            first._handlerFilenames.get("text")
          }.text)`,
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
      // Given every tool, the factory may return scopes, so they are lifted.
      assertStringIncludes(
        plainBundle.code,
        "const signals = __tiny_flattenScopes((() =>",
      );
      assertEquals(plainBundle.module.total.value, 2);
      const expressionBundle = await load(expression);
      assertStringIncludes(
        expressionBundle.code,
        'import { SignalInstance as Signal } from "./tt-signal_',
      );
      assertStringIncludes(
        expressionBundle.code,
        "const signals = (function()",
      );
      assertEquals(expressionBundle.module.label.value, "text");
      const clashingBundle = await load(clashing);
      assertStringIncludes(
        clashingBundle.code,
        "const signals = __tiny_flattenScopes(defineSignals({ Signal: __tiny_Signal,",
      );
      assertEquals(clashingBundle.module.Signal.value, 3);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Signals bundles scope Scope signals to their level's roots",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/instance-signals";
    const layers = new Signals(
      import.meta.url,
      ({ Signal, Computed, Scope }) => {
        const layer = new Scope(() => ({ material: new Signal("bulk") }));
        const materials = new Computed(
          () => layer.material.all.value.join(", "),
          [layer.material.all],
        );
        return { layer, materials };
      },
    );
    const { parseHTML } = await import("linkedom");
    // The second root also roots another collection.
    const window = parseHTML(
      `<html><body><p tt-instance="${layers.scopes.layer.key}"><i id="a"></i></p><p tt-instance="other ${layers.scopes.layer.key}"><i id="b"></i></p></body></html>`,
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
      const a = window.document.getElementById("a")!;
      // `onChange={fn.signals.update(signal.material)}` on an element inside
      // the first root, given its instance as `runHandler` gives it.
      signalMutators().update.call(
        a,
        { type: "change", target: { value: "flow", dataset: {}, name: "" } },
        module.material.forInstance(a),
      );
      assertEquals(module.materials.value, "flow");
      // The second root counts once something inside it resolves a signal.
      module.material.forInstance(window.document.getElementById("b"));
      assertEquals(module.materials.value, "flow, bulk");
      // Read from a handler, the accessor is the per-instance handle.
      assertEquals(module.material.forInstance(a).value, "flow");
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
  name:
    "fn.signals handlers act on the signals they are given, by what each holds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-actions";
    const actions = new Signals(
      import.meta.url,
      ({ Signal, Computed, Trigger, Scope }) => {
        const size = new Signal(76);
        const italic = new Signal(false);
        const reset = new Trigger();
        const doubled = new Computed(() => size.value * 2);
        const row = new Scope(() => ({ open: new Signal(false) }));
        return { size, italic, reset, doubled, row };
      },
    );
    const consumer = new Handlers(import.meta.url, async () => {
      const { signal } = await imports(actions);
      return {
        names: function () {
          return Object.keys(signal);
        },
        flip: function (
          _event: Event,
          own: Signal<boolean>,
          shared: Signal<boolean>,
        ) {
          own.value = !own.value;
          shared.value = !shared.value;
        },
      };
    });
    const { parseHTML } = await import("linkedom");
    const window = parseHTML(
      `<html><body><p tt-instance="${actions.scopes.row.key}"><i id="a"></i></p></body></html>`,
    );
    Object.assign(globalThis, { document: window.document });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = actions._handlerFilenames.get("size")!;
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const module = await import(pathToFileURL(path).href);
      // Signals are the only exports: their handlers are `fn.signals`.
      assertEquals(
        Object.keys(module).filter((name) => name.includes("$")),
        [],
      );
      const mutators = signalMutators();
      const element = window.document.createElement("button");
      mutators.update.call(
        element,
        { type: "input", target: { value: "120", dataset: {}, name: "size" } },
        module.size,
      );
      assertEquals(module.size.value, 120);
      // `add` adds the element's value, which it needs.
      assertThrows(
        () => mutators.add.call(element, new Event("click"), module.size),
        TypeError,
        "fn.signals.add uses the element's value, but <button> has none",
      );
      element.setAttribute("value", "1");
      mutators.add.call(element, new Event("click"), module.size);
      assertEquals(module.size.value, 121);
      element.setAttribute("value", "-5");
      mutators.add.call(element, new Event("click"), module.size);
      assertEquals(module.size.value, 116);
      element.setAttribute("value", "five");
      assertThrows(
        () => mutators.add.call(element, new Event("click"), module.size),
        TypeError,
        "'five' is not a number",
      );
      element.removeAttribute("value");
      // A toggle flips the value whatever the event.
      mutators.toggle.call(element, new Event("click"), module.italic);
      assertEquals(module.italic.value, true);
      const fired = module.reset.value;
      mutators.fire.call(element, new Event("click"), module.reset);
      assertEquals(module.reset.value, fired + 1);
      // A per-instance signal is passed as the instance enclosing the element.
      const a = window.document.getElementById("a")!;
      mutators.toggle.call(a, new Event("click"), module.open.forInstance(a));
      assertEquals(module.open.forInstance(a).value, true);
      // `runHandler` reads each signal from its bundle and passes it on.
      const handlers = (globalThis as unknown as {
        handlers: Record<string, unknown>;
      }).handlers;
      handlers[filename] ??= module;
      handlers[mutatorBundle("toggle")] ??= { toggle: mutators.toggle };
      a.setAttribute(
        "tt-handler-click",
        `${
          mutatorBundle("toggle")
        }.toggle(${filename}.open,${filename}.italic)`,
      );
      runHandler(a, new Event("click"));
      assertEquals(module.open.forInstance(a).value, false);
      assertEquals(module.italic.value, false);
      // Handlers see the signals.
      const consumerPath = `${Deno.cwd()}/${directory}/handlers/${
        consumer._handlerFilenames.get("names")
      }.js`;
      assertEquals(
        (await import(pathToFileURL(consumerPath).href)).names().sort(),
        ["doubled", "italic", "open", "reset", "size"],
      );
      const { fn, signal } = await imports(actions);
      // A handler of your own takes signals the same way, each passed as
      // the signal it is (a per-instance one, the element's instance).
      const consumerFile = consumer._handlerFilenames.get("flip")!;
      handlers[consumerFile] ??= await import(pathToFileURL(consumerPath).href);
      const { fn: own } = await imports(consumer);
      const flip = handlerReferenceAttributes(
        "onClick",
        own.flip(signal.open, signal.italic),
      )?.["tt-handler-click"];
      assertEquals(
        flip,
        `${consumerFile}.flip(${filename}.open,${filename}.italic)`,
      );
      a.setAttribute("tt-handler-click", flip!);
      runHandler(a, new Event("click"));
      assertEquals(module.open.forInstance(a).value, true);
      assertEquals(module.italic.value, true);
      assertThrows(
        // @ts-expect-error A value is not a signal.
        () => own.flip(5, signal.italic),
        TypeError,
        "fn.flip takes signal references from tiny.imports()",
      );
      assertEquals(
        handlerReferenceAttributes("onInput", fn.signals.update(signal.size)),
        {
          oninput: "tiny.runHandler(this,event)",
          "tt-handler-input": `${
            mutatorBundle("update")
          }.update(${filename}.size)`,
        },
      );
      assertEquals(
        handlerReferenceAttributes(
          "onClick",
          fn.signals.add(signal.size, signal.size),
        )?.["tt-handler-click"],
        `${mutatorBundle("add")}.add(${filename}.size,${filename}.size)`,
      );
      // `subscribe` and `update` share a bundle; the rest have their own,
      // which only pages binding one of them load.
      assertEquals(
        mutatorBundle("subscribe"),
        signalSyncTools._handlerFilenames.get("update"),
      );
      assertNotEquals(mutatorBundle("add"), mutatorBundle("update"));
      assertEquals(
        handlerReferenceAttributes(
          "onClick",
          fn.signals.multiply(signal.size),
        )?.["tt-handler-click"],
        `${mutatorBundle("multiply")}.multiply(${filename}.size)`,
      );
      // No bare signal is a handler, a trigger included: each error names
      // the `fn.signals` handler likely meant.
      assertThrows(
        () => handlerReferenceAttributes("onClick", signal.size),
        TypeError,
        "onClick={signal.size} is not a handler",
      );
      assertThrows(
        () => handlerReferenceAttributes("onClick", signal.reset),
        TypeError,
        "onClick={signal.reset} is not a handler: give the signal to one of fn.signals, such as fn.signals.fire(signal.reset)",
      );
      assertThrows(
        () => handlerReferenceAttributes("onConnect", signal.reset),
        TypeError,
        "such as fn.signals.subscribe(signal.reset)",
      );
      assertEquals(
        handlerReferenceAttributes(
          "onConnect",
          fn.signals.subscribe(signal.doubled),
        )?.["tt-handler-connect"],
        `${mutatorBundle("subscribe")}.subscribe(${filename}.doubled)`,
      );
      assertThrows(
        () => handlerReferenceAttributes("onInput", signal.size),
        TypeError,
        "onInput={signal.size} is not a handler",
      );
      assertThrows(
        // @ts-expect-error A computed is read-only.
        () => fn.signals.update(signal.doubled),
        TypeError,
        "fn.signals.update cannot take signal.doubled, which is a computed signal",
      );
      assertThrows(
        // @ts-expect-error Only triggers fire.
        () => fn.signals.fire(signal.size),
        TypeError,
        "fn.signals.fire cannot take signal.size, which is a writable signal",
      );
      assertThrows(
        // @ts-expect-error At least one signal.
        () => fn.signals.toggle(),
        TypeError,
        "needs at least one signal",
      );
      const checkTypes = () => {
        const handlers: [
          JSX.IntrinsicElements["input"],
          JSX.IntrinsicElements["button"],
        ] = [
          {
            onInput: fn.signals.update(signal.size),
            onChange: fn.signals.update(signal.italic),
          },
          {
            onClick: [
              fn.signals.toggle(signal.italic, signal.open),
              fn.signals.add(signal.size),
              fn.signals.multiply(signal.size),
              fn.signals.fire(signal.reset),
            ],
            onConnect: fn.signals.subscribe(signal.doubled, signal.reset),
          },
        ];
        // @ts-expect-error A boolean cannot be added to.
        fn.signals.add(signal.italic);
        // @ts-expect-error A boolean cannot be multiplied.
        fn.signals.multiply(signal.italic);
        const bare: JSX.IntrinsicElements["input"] = {
          // @ts-expect-error A signal is not a handler on its own.
          onInput: signal.size,
          // @ts-expect-error Nor is a trigger.
          onClick: signal.reset,
          // @ts-expect-error Nor on a lifecycle event.
          onConnect: signal.reset,
        };
        void bare;
        // @ts-expect-error A number cannot be toggled.
        fn.signals.toggle(signal.size);
        // @ts-expect-error A trigger has no value to update.
        fn.signals.update(signal.reset);
        // @ts-expect-error A number is not a boolean.
        own.flip(signal.size, signal.italic);
        // @ts-expect-error Both signals are needed.
        own.flip(signal.open);
        const flipped: JSX.IntrinsicElements["button"] = {
          onClick: own.flip(signal.open, signal.italic),
        };
        void flipped;
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
      assertEquals(typeof click, "function");
      assertEquals(typeof submit, "function");
      assertEquals(typeof incorrect, "function");
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
