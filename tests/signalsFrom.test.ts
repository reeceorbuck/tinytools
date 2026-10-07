import { assertEquals, assertStringIncludes } from "@std/assert";
import { pathToFileURL } from "node:url";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Constants,
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
import { type Signal, signalClasses } from "../signals.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

Deno.test("signalsFrom makes one writable signal per entry, typed from it", () => {
  const { signalsFrom, Computed } = signalClasses();
  const signals = signalsFrom({
    shade: "B1" as "B1" | "A1",
    tolerance: 3,
    surfaces: ["O"] as readonly string[],
  });
  const shade: Signal<"B1" | "A1"> = signals.shade;
  const tolerance: Signal<number> = signals.tolerance;
  // @ts-expect-error the value type comes from the entry
  const wrong: Signal<string> = signals.tolerance;
  void wrong;
  const label = new Computed(() =>
    `${shade.value} ${tolerance.value} ${signals.surfaces.value.join("")}`
  );
  assertEquals(label.value, "B1 3 O");
  shade.value = "A1";
  signals.surfaces.value = ["O", "D"];
  assertEquals(label.value, "A1 3 OD");
});

Deno.test({
  name:
    "a factory can use signalsFrom on imported constants, server and browser",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signals-from";
    const defaults = new Constants<{ shade: string; tolerance: number }>({
      shade: "B1",
      tolerance: 3,
    });
    const collection = new Signals(import.meta.url, async () => {
      const { constants } = await imports(defaults);
      return ({ Computed, signalsFrom }) => {
        const signals = signalsFrom(constants);
        const label = new Computed(() =>
          `${signals.shade.value} ${signals.tolerance.value}`
        );
        return { ...signals, label };
      };
    });
    try {
      assertEquals(await collection.evaluateUsingInitialValues(), {
        shade: "B1",
        tolerance: 3,
        label: "B1 3",
      });
      assertEquals(
        (await collection.evaluateUsingInitialValues({ tolerance: 5 })).label,
        "B1 5",
      );

      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = collection._handlerFilenames.get("label")!;
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      assertStringIncludes(await Deno.readTextFile(path), "signalsFrom");
      const module = await import(pathToFileURL(path).href);
      assertEquals(module.label().value, "B1 3");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});
