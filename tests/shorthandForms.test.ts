import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { pathToFileURL } from "node:url";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
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
import type { Signal } from "../signals.ts";
import { optimized } from "../honoFactory.tsx";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

Deno.test("Signals rejects initial values a signal cannot hold", () => {
  reset();
  assertThrows(
    // @ts-expect-error objects are not signal values
    () => new Signals({ point: { x: 1 } }),
    TypeError,
    "Signal 'point' needs",
  );
  assertThrows(() => new Signals({ ratio: NaN }), TypeError, "'ratio'");
  reset();
});

Deno.test({
  name: "Signals takes plain initial values, with or without a source URL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/shorthand-signals";
    const counter = new Signals({ count: 0, tags: ["a"] as readonly string[] });
    const sourced = new Signals(import.meta.url, { label: "hi", on: false });
    const checkTypes = async () => {
      const { signal } = await imports(counter, sourced);
      const count: Signal<number> = signal.count;
      // @ts-expect-error count is typed from its initial value
      const wrong: Signal<string> = signal.count;
      void [count, wrong];
    };
    void checkTypes;
    try {
      assertEquals(await counter.evaluateUsingInitialValues(), {
        count: 0,
        tags: ["a"],
      });
      assertEquals(await sourced.evaluateUsingInitialValues({ on: true }), {
        label: "hi",
        on: true,
      });
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = counter._handlerFilenames.get("count")!;
      const code = await Deno.readTextFile(
        `${Deno.cwd()}/${directory}/handlers/${filename}.js`,
      );
      assertStringIncludes(code, "signalsFrom");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Handlers can take the tools they import before their factory",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/shorthand-handlers";
    const counter = new Signals({ count: 0 });
    const helpers = new Handlers({
      double(value: number) {
        return value * 2;
      },
    });
    const clicks = new Handlers(counter, ({ signal }) => ({
      add() {
        signal.count.value++;
      },
    }));
    const sourced = new Handlers(
      import.meta.url,
      [counter, helpers],
      ({ signal, fn }) => ({
        addDouble() {
          signal.count.value += fn.double(1);
        },
      }),
    );
    const checkTypes = async () => {
      const { fn } = await imports(clicks, sourced);
      void [fn.add, fn.addDouble];
      new Handlers(counter, ({ signal }) => ({
        bad() {
          // @ts-expect-error count holds a number
          signal.count.value = "x";
        },
      }));
    };
    void checkTypes;
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const read = (filename: string) =>
        Deno.readTextFile(`${Deno.cwd()}/${directory}/handlers/${filename}.js`);
      const signalFile = counter._handlerFilenames.get("count")!;
      const clicksCode = await read(clicks._handlerFilenames.get("add")!);
      assertStringIncludes(clicksCode, `./${signalFile}.js`);
      const sourcedCode = await read(
        sourced._handlerFilenames.get("addDouble")!,
      );
      assertStringIncludes(sourcedCode, `./${signalFile}.js`);
      assertStringIncludes(
        sourcedCode,
        `./${helpers._handlerFilenames.get("double")}.js`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("Handlers listing tools needs a factory after them", () => {
  reset();
  const counter = new Signals({ count: 0 });
  assertThrows(
    // @ts-expect-error the last argument must be a factory
    () => new Handlers(counter, { add() {} }),
    TypeError,
    "needs a factory",
  );
  reset();
});

Deno.test("Handlers takes several tools as one array, not one by one", () => {
  reset();
  const counter = new Signals({ count: 0 });
  const helpers = new Handlers({ noop() {} });
  const checkTypes = () => {
    new Handlers([helpers, counter], ({ signal, fn }) => ({
      add() {
        fn.noop();
        signal.count.value++;
      },
    }));
  };
  void checkTypes;
  assertThrows(
    // @ts-expect-error several tools go in an array
    () => new Handlers(helpers, counter, () => ({})),
    TypeError,
    "an array for several",
  );
  reset();
});

Deno.test("Signals widens lone literals and keeps unions given with as", () => {
  reset();
  const signals = new Signals({
    shade: "B1" as "B1" | "A1",
    label: "hi",
    on: false,
  });
  const checkTypes = async () => {
    const { signal } = await imports(signals);
    const shade: Signal<"B1" | "A1"> = signal.shade;
    const label: Signal<string> = signal.label;
    const on: Signal<boolean> = signal.on;
    // @ts-expect-error the union is kept
    signal.shade.value = "C3";
    void [shade, label, on];
  };
  void checkTypes;
  reset();
});

Deno.test({
  name: "Signals can read another collection's signals, server and browser",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/shorthand-upstream";
    const counter = new Signals({ count: 0 });
    const parity = new Signals(counter, ({ signal }) => ({
      isEven: () => signal.count.value % 2 === 0,
      label: "parity",
    }));
    const doubled = new Signals(import.meta.url, [counter, parity], (
      { signal },
    ) => ({
      doubled: () => signal.count.value * 2,
      evenText: () => signal.isEven.value ? "even" : "odd",
    }));
    const checkTypes = async () => {
      const { signal } = await imports(parity, doubled);
      const isEven: boolean = signal.isEven.value;
      const label: Signal<string> = signal.label;
      // @ts-expect-error a computed is read-only
      signal.isEven.value = true;
      void [isEven, label];
    };
    void checkTypes;
    try {
      assertEquals(await parity.evaluateUsingInitialValues(), {
        isEven: true,
        label: "parity",
      });
      assertEquals(
        await doubled.evaluateUsingInitialValues(),
        { doubled: 0, evenText: "even" },
      );
      await buildScriptFiles({ fresh: true, publicDir: directory });

      // Inputs given to the upstream collection in the same imports reach it.
      const { signal } = await imports(
        counter.withInputs({ count: 3 }),
        parity,
        doubled,
      );
      assertEquals(
        [
          signal.isEven.initial,
          signal.doubled.initial,
          signal.evenText.initial,
        ],
        [false, 6, "odd"],
      );

      const load = (filename: string | undefined) =>
        import(
          pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${filename}.js`)
            .href
        );
      const counterModule = await load(counter._handlerFilenames.get("count"));
      const parityModule = await load(parity._handlerFilenames.get("isEven"));
      const doubledModule = await load(
        doubled._handlerFilenames.get("doubled"),
      );
      assertEquals(parityModule.isEven().value, true);
      counterModule.count().value = 5;
      assertEquals(parityModule.isEven().value, false);
      assertEquals(doubledModule.doubled().value, 10);
      assertEquals(doubledModule.evenText().value, "odd");
      parityModule.label().value = "changed";
      assertEquals(parityModule.label().value, "changed");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("Signals cannot read another collection's per-instance signals", async () => {
  reset();
  const rows = new Signals(({ Signal, perInstance }) =>
    perInstance(() => ({ open: new Signal(false) }))
  );
  const reader = new Signals(rows, ({ signal }) => ({
    // @ts-expect-error a per-instance signal has no single value
    shut: () => !signal.open.value,
  }));
  await assertRejects(
    () => reader.evaluateUsingInitialValues(),
    TypeError,
    "per-instance",
  );
  reset();
});

Deno.test({
  name: "optimized gives every collection the file's source URL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/shorthand-optimized";
    const tiny = optimized(import.meta.url);
    const counter = new tiny.Signals({ count: 0 });
    const parity = new tiny.Signals(counter, ({ signal }) => ({
      isEven: () => signal.count.value % 2 === 0,
    }));
    const clicks = new tiny.Handlers(counter, ({ signal }) => ({
      add() {
        signal.count.value++;
      },
    }));
    // A URL of its own still wins, and is not given twice.
    const own = new tiny.Handlers(import.meta.url, { ownSource() {} });
    const unsourced = new Handlers({ plain() {} });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const names = [
        counter._handlerFilenames.get("count"),
        parity._handlerFilenames.get("isEven"),
        clicks._handlerFilenames.get("add"),
        own._handlerFilenames.get("ownSource"),
      ];
      for (const name of names) {
        assertStringIncludes(name ?? "", "shorthandForms");
      }
      assertStringIncludes(
        unsourced._handlerFilenames.get("plain") ?? "",
        "plain_handler",
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});
