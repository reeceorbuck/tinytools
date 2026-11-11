import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { pathToFileURL } from "node:url";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
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
import { signalRuntimeSources } from "../signalModules.ts";
import { optimized } from "../honoFactory.tsx";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

/** A `Storage` held in memory, standing in for the browser's. */
class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  clear(): void {
    this.#items.clear();
  }
}

/** Runs `fn` with `localStorage` and `sessionStorage` replaced. */
async function withStorage(
  fn: (storage: { local: MemoryStorage; session: MemoryStorage }) => unknown,
) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const saved = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    sessionStorage: Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage",
    ),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: local,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: session,
    configurable: true,
  });
  try {
    await fn({ local, session });
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

Deno.test("a persisted signal takes no server input and renders its initial value", () => {
  reset();
  const collection = new Signals(({ Signal, Computed }) => {
    const stops = new Signal<string[]>([]);
    const count = new Computed(() => stops.value.length);
    return { stops, count, query: new Signal("") };
  }, { persist: { stops: { local: "test.stops" } } });
  assertEquals(collection.evaluateUsingInitialValues(), {
    stops: [],
    count: 0,
    query: "",
  });
  assertEquals(
    collection.evaluateUsingInitialValues({ query: "x" }).query,
    "x",
  );
  assertThrows(
    // @ts-expect-error a persisted signal is not a server input
    () => collection.evaluateUsingInitialValues({ stops: ["12345"] }),
    TypeError,
    "persisted in the browser",
  );
  reset();
});

Deno.test("persist works on a shape whose computeds read this", async () => {
  reset();
  const source = new Signals({ limit: 12 });
  const collection = new Signals(source, ({ signal }) => ({
    stops: ["1", "2"] as readonly string[],
    query: "",
    shown() {
      return this.stops.value.slice(0, signal.limit.value).join(" ");
    },
  }), { persist: { stops: { local: "test.shape.stops" } } });
  assertEquals((await collection.evaluateUsingInitialValues()).shown, "1 2");
  await assertRejects(
    // @ts-expect-error a persisted signal is not a server input
    () => collection.evaluateUsingInitialValues({ stops: ["1"] }),
    TypeError,
    "persisted in the browser",
  );
  const wrong = new Signals(source, () => ({ a: 1, b: () => 2 }), {
    persist: { b: { local: "k" } },
  });
  // @ts-expect-error persisting a computed leaves no collection to use
  await assertRejects(() => imports(wrong), TypeError, "only writable");
  reset();
});

Deno.test("persist rejects signals it cannot store and malformed storage", async () => {
  reset();
  const cases: [() => unknown, string][] = [
    [
      () =>
        // @ts-expect-error only writable signals can be persisted
        new Signals(({ Signal, Computed }) => {
          const count = new Signal(0);
          return { count, double: new Computed(() => count.value * 2) };
        }, {
          persist: { double: { local: "k" } },
        }),
      "only writable signals",
    ],
    [
      () =>
        new Signals(
          ({ Signal, Scope }) => new Scope(() => ({ open: new Signal(false) })),
          {
            persist: { open: { local: "k" } },
          },
        ),
      "per-instance",
    ],
    [
      // @ts-expect-error not a signal of the collection
      () => new Signals({ count: 0 }, { persist: { other: { local: "k" } } }),
      "not defined",
    ],
  ];
  for (const [make, message] of cases) {
    const collection = make() as { ensureDefined(): Promise<unknown> };
    let error: unknown;
    try {
      await imports(collection as never);
    } catch (caught) {
      error = caught;
    }
    assert(
      error instanceof TypeError && error.message.includes(message),
      `expected "${message}", got ${error}`,
    );
    reset();
  }
  assertThrows(
    () =>
      // @ts-expect-error both areas at once
      new Signals({ count: 0 }, {
        persist: { count: { local: "k", session: "k" } },
      }),
    TypeError,
    "Cannot persist 'count'",
  );
  assertThrows(
    () =>
      // @ts-expect-error session storage is one tab's, so it has no sync
      new Signals({ count: 0 }, {
        persist: { count: { session: "k", sync: true } },
      }),
    TypeError,
    "Cannot persist 'count'",
  );
  assertThrows(
    // @ts-expect-error not an option
    () => new Signals({ count: 0 }, { keep: {} }),
    TypeError,
    "Unknown tiny.Signals option",
  );
  reset();
});

Deno.test({
  name:
    "the bundle restores, stores and syncs persisted signals in browser storage",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/persisted-signals";
    const tiny = optimized(import.meta.url);
    const collection = new tiny.Signals(({ Signal }) => ({
      stops: new Signal<string[]>([]),
      shade: new Signal("B1"),
      zoom: new Signal(1),
      draft: new Signal(""),
    }), {
      persist: {
        stops: { local: "test.stops", sync: true },
        shade: { local: "test.shade" },
        zoom: { local: "test.zoom" },
        draft: { session: "test.draft" },
      },
    });
    const plain = new tiny.Signals({ other: 0 });
    try {
      await imports(collection, plain);
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const persistFile = [...signalRuntimeSources.keys()].find((file) =>
        file.startsWith("tt-persist_")
      )!;
      assert(persistFile);
      const bundle = async (target: typeof collection | typeof plain) => {
        const filename = target._handlerFilenames.values().next().value!;
        const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
        return { path, source: await Deno.readTextFile(path) };
      };
      // Only a collection that persists imports the storage runtime.
      assert((await bundle(collection)).source.includes(persistFile));
      assertFalse((await bundle(plain)).source.includes("tt-persist_"));

      await withStorage(async ({ local, session }) => {
        local.setItem("test.stops", JSON.stringify(["17967", "10101"]));
        // A stored value of another type, or not JSON, is ignored.
        local.setItem("test.shade", "42");
        local.setItem("test.zoom", "{not json");
        session.setItem("test.draft", JSON.stringify("half a note"));

        const { path } = await bundle(collection);
        const module = await import(pathToFileURL(path).href);
        assertEquals(module.stops.value, ["17967", "10101"]);
        assertEquals(module.shade.value, "B1");
        assertEquals(module.zoom.value, 1);
        assertEquals(module.draft.value, "half a note");

        module.stops.value = ["20000"];
        assertEquals(local.getItem("test.stops"), '["20000"]');
        module.zoom.value = 2;
        assertEquals(local.getItem("test.zoom"), "2");
        // Back to the initial value: nothing is left stored.
        module.stops.value = [];
        assertEquals(local.getItem("test.stops"), null);

        // Another tab's change arrives through the storage event.
        const fromOtherTab = (key: string | null, newValue: string | null) =>
          globalThis.dispatchEvent(
            Object.assign(new Event("storage"), {
              storageArea: local,
              key,
              newValue,
            }),
          );
        fromOtherTab("test.stops", '["30000"]');
        assertEquals(module.stops.value, ["30000"]);
        // Restoring is not echoed back into storage.
        assertEquals(local.getItem("test.stops"), null);
        fromOtherTab(null, null);
        assertEquals(module.stops.value, []);
        // `zoom` does not sync.
        fromOtherTab("test.zoom", "5");
        assertEquals(module.zoom.value, 2);
      });
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});
