import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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
import type { SignalTools } from "../signals.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

const defaultValues = {
  shade: "B1",
  tolerance: 3,
  surfaces: ["O", "D"],
  nested: { depth: "moderate" },
};

type DefaultValues = typeof defaultValues;

/** A module-scope value a factory captures by mistake. */
const captured = { shade: "A2" };

function createSignals(values: InstanceType<typeof Constants<DefaultValues>>) {
  return new Signals(import.meta.url, async () => {
    const { constants } = await imports(values);
    return ({ Signal, Computed }) => {
      const shade = new Signal(constants.shade);
      const tolerance = new Signal(constants.tolerance);
      const label = new Computed(() =>
        `${shade.value} ${constants.nested.depth} ${
          constants.surfaces.join("")
        } ${tolerance.value}`
      );
      return { shade, tolerance, label };
    };
  });
}

function createHandlers(values: InstanceType<typeof Constants<DefaultValues>>) {
  return new Handlers(import.meta.url, async () => {
    const { constants } = await imports(values);
    return {
      describe(prefix: string) {
        return `${prefix} ${constants.shade} ${constants.nested.depth}`;
      },
    };
  });
}

Deno.test({
  name: "Signals embed imported constants in the bundle and evaluate with them",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-constants";
    const collection = createSignals(new Constants(defaultValues));
    const changed = createSignals(
      new Constants({ ...defaultValues, shade: "A1" }),
    );
    try {
      assertEquals(await collection.evaluateUsingInitialValues(), {
        shade: "B1",
        tolerance: 3,
        label: "B1 moderate OD 3",
      });
      assertEquals((await changed.evaluateUsingInitialValues()).shade, "A1");

      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = collection._handlerFilenames.get("shade")!;
      // A different value is a different bundle.
      assertNotEquals(filename, changed._handlerFilenames.get("shade"));
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const code = await Deno.readTextFile(path);
      assertStringIncludes(code, "const constants = {");
      assertStringIncludes(code, '"moderate"');
      const module = await import(pathToFileURL(path).href);
      assertEquals(module.shade().value, "B1");
      assertEquals(module.label().value, "B1 moderate OD 3");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Handlers factories read imported constants on the server and browser",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/handler-constants";
    const collection = createHandlers(new Constants(defaultValues));
    try {
      await collection.ensureDefined();
      assertEquals(collection.run.describe("Shade"), "Shade B1 moderate");

      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = collection._handlerFilenames.get("describe")!;
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const code = await Deno.readTextFile(path);
      assertStringIncludes(code, "const constants = {");
      const module = await import(pathToFileURL(path).href);
      assertEquals(module.describe("Shade"), "Shade B1 moderate");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("a factory capturing a module value fails on the server with guidance", async () => {
  reset();
  try {
    const capturing = new Signals(import.meta.url, ({ Signal }) => ({
      shade: new Signal<string>(captured.shade),
    }));
    await assertRejects(
      () => capturing.ensureDefined(),
      TypeError,
      "references 'captured'",
    );
    assertThrows(
      () => capturing.evaluateUsingInitialValues(),
      TypeError,
      "tiny.Constants",
    );
  } finally {
    reset();
  }
});

Deno.test("constants must be JSON values, imported once each", async () => {
  reset();
  try {
    assertThrows(
      // @ts-expect-error undefined does not survive a JSON round trip
      () => new Constants({ missing: undefined }),
      TypeError,
      "JSON value",
    );
    assertThrows(
      // @ts-expect-error functions are not constants
      () => new Constants({ compute: () => 1 }),
      TypeError,
      "JSON value",
    );

    const first = new Constants({ shade: "B1" });
    const second = new Constants({ shade: "A1" });
    const duplicated = new Signals(import.meta.url, async () => {
      await imports(first, second);
      return ({ Signal }) => ({ count: new Signal(1) });
    });
    await assertRejects(
      () => duplicated.ensureDefined(),
      Error,
      "Duplicate imported constant 'shade'",
    );

    // Outside a definition the merged values are returned as they are.
    assertEquals((await imports(first)).constants, { shade: "B1" });

    // The values are a copy: later changes to the source do not leak in.
    const source = { shade: "B1" };
    const copied = new Constants(source);
    source.shade = "A3";
    assertEquals(copied.values.shade, "B1");

    const factory = ({ Signal }: SignalTools) => ({ count: new Signal(1) });
    assertThrows(
      // @ts-expect-error the constants argument was removed
      () => new Signals(import.meta.url, factory, { shade: "B1" }),
      TypeError,
      "no longer takes constants",
    );
  } finally {
    reset();
  }
});
