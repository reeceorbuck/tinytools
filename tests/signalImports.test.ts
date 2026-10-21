import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Constants,
  Handlers,
  imports,
  registeredClientTools,
  Signals,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import { Fragment, jsx } from "../jsx-runtime.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import type { Signal, SignalTools, SignalValue } from "../signals.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

const defaults = new Constants<{ shade: string; tolerance: number }>({
  shade: "B1",
  tolerance: 3,
});

function createHelpers() {
  return new Handlers(import.meta.url, {
    signalsFrom<Values extends Record<string, SignalValue>>(
      Signal: SignalTools["Signal"],
      initialValues: Values,
    ): { [Key in keyof Values]: Signal<Values[Key]> } {
      return Object.fromEntries(
        Object.entries(initialValues).map((
          [key, value],
        ) => [key, new Signal(value)]),
      ) as { [Key in keyof Values]: Signal<Values[Key]> };
    },
    unused() {
      return "unused";
    },
  });
}

/**
 * Outside the test body: a local `fn` there would clash with the test's own
 * `fn` method and be renamed by the transpiler.
 */
function createCollection(helpers: ReturnType<typeof createHelpers>) {
  return new Signals(import.meta.url, async () => {
    const { fn, constants } = await imports(helpers, defaults);
    return ({ Signal, Computed }) => {
      const { shade, tolerance } = fn.signalsFrom(Signal, constants);
      const label = new Computed(() => `${shade.value} ${tolerance.value}`);
      return { shade, tolerance, label };
    };
  });
}

Deno.test({
  name: "an async Signals definition imports handlers for server and browser",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-imports";
    const helpers = createHelpers();
    const collection = createCollection(helpers);
    const checkTypes = async () => {
      const values = await collection.evaluateUsingInitialValues();
      // @ts-expect-error tolerance is typed from the default
      const tolerance: string = values.tolerance;
      void tolerance;
    };
    void checkTypes;
    try {
      assertEquals(await collection.evaluateUsingInitialValues(), {
        shade: "B1",
        tolerance: 3,
        label: "B1 3",
      });
      assertEquals(
        (await collection.evaluateUsingInitialValues({ shade: "A2" })).label,
        "A2 3",
      );

      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = collection._handlerFilenames.get("shade")!;
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const code = await Deno.readTextFile(path);
      assertStringIncludes(
        code,
        `from "./${helpers._handlerFilenames.get("signalsFrom")}.js"`,
      );
      assertEquals(code.includes("unused"), false);
      const module = await import(pathToFileURL(path).href);
      assertEquals(module.shade().value, "B1");
      assertEquals(module.label().value, "B1 3");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("Signals definitions reject captures, signal imports and non-factories", async () => {
  reset();
  try {
    const helpers = createHelpers();
    const local = { shade: "A1" };
    const capturing = new Signals(import.meta.url, async () => {
      await imports(helpers);
      return ({ Signal }) => ({ shade: new Signal<string>(local.shade) });
    });
    await assertRejects(
      () => capturing.ensureDefined(),
      TypeError,
      "references 'local'",
    );

    const other = new Signals(import.meta.url, ({ Signal }) => ({
      count: new Signal(1),
    }));
    const importingSignals = new Signals(import.meta.url, async () => {
      await imports(other);
      return ({ Signal }) => ({ shade: new Signal("B1") });
    });
    await assertRejects(
      () => importingSignals.ensureDefined(),
      TypeError,
      "can import handlers only",
    );

    const notAFactory = new Signals(
      import.meta.url,
      // @ts-expect-error the definition must resolve to a factory
      async () => {
        await imports(helpers);
        return { shade: 1 };
      },
    );
    await assertRejects(
      () => notAFactory.ensureDefined(),
      TypeError,
      "must resolve to a synchronous factory",
    );
  } finally {
    reset();
  }
});

Deno.test({
  name: "a signal name defined by two imported collections is ambiguous",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-ambiguous";
    const images = new Signals(import.meta.url, ({ Signal }) => ({
      opens: new Signal(0),
      imageSrc: new Signal(""),
    }));
    const attachments = new Signals(import.meta.url, ({ Signal }) => ({
      opens: new Signal(0),
      href: new Signal(""),
    }));
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { signal } = await imports(images, attachments);
      // Names only one collection defines still resolve.
      assertExists(signal.imageSrc);
      assertThrows(() => signal.opens, Error, "Ambiguous signal 'opens'");
      // Imported separately, each collection's `opens` is unambiguous.
      assertExists((await imports(images)).signal.opens);
      assertExists((await imports(attachments)).signal.opens);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "signal.name.initial and a signal placed as a child render its initial value",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-bind";
    const counters = new Signals(import.meta.url, ({ Signal, Computed }) => {
      const count = new Signal(3);
      const doubled = new Computed(() => count.value * 2, [count]);
      return { count, doubled };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { signal } = await imports(counters);
      const html = String(
        jsx("p", {
          children: [
            signal.count,
            " doubled is ",
            signal.doubled,
          ],
        }),
      );
      assertEquals([signal.count.initial, signal.doubled.initial], [3, 6]);
      assertEquals(
        String(jsx(Fragment, { children: signal.count })),
        String(jsx("p", { children: signal.count })).slice(3, -4),
      );
      assertThrows(() => `${signal.count}`, Error, "turned into a string");
      const bound = (handler: string, value: number) =>
        `<signal-text onconnect="tiny.runHandler(this,event)" tt-handler-connect="${handler}" onsignal="tiny.runHandler(this,event)" tt-handler-signal="signals.setTextContent">${value}</signal-text>`;
      assertEquals(
        // Bundle names carry content hashes.
        html.replace(/(\w+)_[0-9a-f]{5}\./g, "$1."),
        `<p>${bound("signalImports_test.count", 3)} doubled is ${
          bound("signalImports_test.doubled", 6)
        }</p>`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "collection.withInputs() starts imported signals from those inputs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-with-inputs";
    const wages = new Signals(import.meta.url, ({ Signal, Computed }) => {
      const production = new Signal<number>(0);
      const pay = new Computed(() => `$${production.value * 0.4}`, [
        production,
      ]);
      return { production, pay };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const withInputs = wages.withInputs({ production: 1000 });
      // Anywhere but tiny.imports() it is the collection itself.
      assertEquals(withInputs.instanceKey, wages.instanceKey);
      assertEquals(withInputs.evaluateUsingInitialValues().pay, "$0");
      const { signal } = await imports(withInputs);
      assertEquals([signal.production.initial, signal.pay.initial], [
        1000,
        "$400",
      ]);
      assertStringIncludes(
        String(jsx("p", { children: signal.pay })),
        ">$400</signal-text>",
      );
      // Inputs belong to that import only.
      assertEquals((await imports(wages)).signal.pay.initial, "$0");
      const { signal: wrong } = await imports(
        wages.withInputs({ pay: "$1" } as never),
      );
      assertThrows(() => wrong.pay.initial, Error);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("a build writes signalTools only for an app that defines signals", async () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/signal-build.ts", import.meta.url),
  );
  /** Whether a fresh build wrote the bundle holding `setTextContent`. */
  const writesSignalTools = async (kind: string) => {
    const directory = `./.test-build-output/signal-build-${kind}`;
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-lock", "-A", fixture, directory, kind],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
      );
      for await (const entry of Deno.readDir(`${directory}/handlers`)) {
        const code = await Deno.readTextFile(
          `${directory}/handlers/${entry.name}`,
        );
        if (code.includes("setTextContent")) return true;
      }
      return false;
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    }
  };
  assertEquals(await writesSignalTools("signals"), true);
  assertEquals(await writesSignalTools("handlers"), false);
});
