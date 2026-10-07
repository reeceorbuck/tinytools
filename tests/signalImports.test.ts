import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { pathToFileURL } from "node:url";
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
