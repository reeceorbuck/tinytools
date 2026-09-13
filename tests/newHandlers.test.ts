import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { pathToFileURL } from "node:url";
import { compileHandlerNamespace } from "../handlerNamespace.ts";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Handlers,
  imports,
  NewHandlers,
  registeredClientTools,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import { handlers, resetImportRegistries } from "../clientFunctions.ts";
import type { JSX } from "../jsx-runtime.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

Deno.test({
  name:
    "Handlers factory collects private imports without executing handler bodies",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    let definitions = 0;
    assertEquals(NewHandlers, Handlers);
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
      assertEquals([...collection._handlerFilenames.keys()], ["consumer"]);
      const consumer = collection._handlerDefinitions.get("consumer")!;
      const code = await consumer.buildCode();
      assertStringIncludes(
        code,
        dependency._handlerDefinitions.get("used")!.filename,
      );
      assertEquals(
        code.includes(dependency._handlerDefinitions.get("unused")!.filename),
        false,
      );
      const reference: (value: number) => number =
        collection.getFunctionReferences.consumer;
      assertEquals(typeof reference, "string");
      // @ts-expect-error imported handlers are private
      collection.getFunctionReferences.used;
    } finally {
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "handler namespace retains only statically used external handlers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    try {
      const dependencies = new Map([
        ["used", "./used_hash.js"],
        ["unused", "./unused_hash.js"],
      ]);
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
        const result = await compileHandlerNamespace(
          body,
          "consumer",
          "consumer_hash",
          dependencies,
        );
        assertEquals(result.imports, ["./used_hash.js"]);
        assertStringIncludes(result.code, 'import used from "./used_hash.js"');
        assertEquals(result.code.includes("unused_hash"), false);
        assertStringIncludes(result.code, "globalThis.handlers");
        assertStringIncludes(result.code, "consumer_hash");
      }
      const dynamic = await compileHandlerNamespace(
        "function(name, event) { return fn[name](event); }",
        "consumer",
        "consumer_hash",
        dependencies,
      );
      assertEquals(dynamic.imports.sort(), [...dependencies.values()].sort());
      const registry = globalThis as typeof globalThis & {
        handlers?: Record<string, unknown>;
      };
      const previousHandlers = registry.handlers;
      try {
        registry.handlers = {};
        for (
          const exportName of [
            "used",
            "fn",
            "_handler",
            "default",
            "some-handler",
          ]
        ) {
          const dependencyUrl =
            "data:text/javascript,export default value => value + 1";
          const result = await compileHandlerNamespace(
            `function(used) { return fn[${
              JSON.stringify(exportName)
            }](used); }`,
            "consumer",
            "readable_names_test",
            new Map([[exportName, dependencyUrl]]),
          );
          assertEquals(result.imports, [dependencyUrl]);
          const module = await import(
            `data:text/javascript,${encodeURIComponent(result.code)}`
          );
          assertEquals(module.default(41), 42);
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
        const result = await compileHandlerNamespace(
          body,
          "consumer",
          "consumer_hash",
          dependencies,
        );
        assertEquals(result.imports, []);
      }
      await assertRejects(
        () =>
          compileHandlerNamespace(
            "function() { fn.missing(); }",
            "consumer",
            "consumer_hash",
            dependencies,
          ),
        Error,
        "missing",
      );
    } finally {
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "NewHandlers rejects duplicate imports, definition calls, and cycles",
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
    assertThrows(() => cycleA.getFunctionReferences, Error, "not ready");
    reset();
  },
});

Deno.test({
  name:
    "NewHandlers keeps concurrent same-file collections isolated and supports legacy consumers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const first = new NewHandlers(import.meta.url, () => ({
      shared: function () {
        return "first";
      },
    }));
    const second = new NewHandlers(import.meta.url, () => ({
      shared: function () {
        return "second";
      },
    }));
    const left = new NewHandlers(import.meta.url, async () => {
      const { fn } = await imports(first);
      await Promise.resolve();
      return {
        consumer: function () {
          return fn.shared();
        },
      };
    });
    const right = new NewHandlers(import.meta.url, async () => {
      const { fn } = await imports(second);
      return {
        consumer: function () {
          return fn.shared();
        },
      };
    });
    const legacy = new Handlers(import.meta.url, { imports: [left] }, {
      own: function () {
        return "legacy";
      },
    });
    try {
      await Promise.all([
        left.ensureDefined(),
        right.ensureDefined(),
        legacy.ensureDefined(),
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
      assertEquals([...legacy._handlerFilenames.keys()], ["consumer", "own"]);
      assertEquals(
        legacy._handlerDefinitions.get("consumer"),
        left._handlerDefinitions.get("consumer"),
      );
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "NewHandlers filenames do not depend on asynchronous completion order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const buildPair = async (reverse: boolean) => {
      reset();
      const first = new NewHandlers(
        import.meta.url,
        () => ({
          shared: function () {
            return "first";
          },
        }),
      );
      const second = new NewHandlers(
        import.meta.url,
        () => ({
          shared: function () {
            return "second";
          },
        }),
      );
      const left = new NewHandlers(import.meta.url, async () => {
        const { fn } = await imports(first);
        return {
          consumer: function () {
            return fn.shared();
          },
        };
      });
      const right = new NewHandlers(import.meta.url, async () => {
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
  name: "NewHandlers initializes in production and preserves JSX handler types",
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
      const { fn, handlers: references } = await imports(collection);
      const click: NonNullable<JSX.IntrinsicElements["button"]["onClick"]> =
        fn.click;
      const submit: NonNullable<JSX.IntrinsicElements["form"]["onSubmit"]> =
        fn.submit;
      // @ts-expect-error submit handlers cannot be used as button click handlers
      const incorrect: NonNullable<JSX.IntrinsicElements["button"]["onClick"]> =
        fn.submit;
      assertEquals(typeof click, "string");
      assertEquals(typeof submit, "string");
      assertEquals(typeof incorrect, "string");
      assertEquals(typeof references.click, "object");
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
    "NewHandlers lazy rebuild hashes track used dependencies only through multiple hops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/new-handler-rebuild";
    const leaf = new NewHandlers(import.meta.url, () => ({
      used: function () {
        return 1;
      },
      unused: function () {
        return 100;
      },
    }));
    const middle = new NewHandlers(import.meta.url, async () => {
      const { fn } = await imports(leaf);
      return {
        forward: function () {
          return fn.used();
        },
      };
    });
    const root = new NewHandlers(import.meta.url, async () => {
      const { fn } = await imports(middle);
      return {
        consumer: function () {
          return fn.forward();
        },
      };
    });
    try {
      await buildScriptFiles({ publicDir: directory });
      const initialName = root._handlerFilenames.get("consumer")!;
      const initialCode = await Deno.readTextFile(
        `${directory}/handlers/${initialName}.js`,
      );
      leaf._handlerDefinitions.get("unused")!.fn = function () {
        return 200;
      };
      cache.beginChangeDetectionPass();
      await leaf._handlerDefinitions.get("unused")!.revalidateAndBuild(
        `${directory}/handlers`,
      );
      await root._handlerDefinitions.get("consumer")!.revalidateAndBuild(
        `${directory}/handlers`,
      );
      cache.commitPendingSourceMtimes();
      assertEquals(root._handlerFilenames.get("consumer"), initialName);
      assertEquals(
        await Deno.readTextFile(`${directory}/handlers/${initialName}.js`),
        initialCode,
      );
      leaf._handlerDefinitions.get("used")!.fn = function () {
        return 2;
      };
      cache.beginChangeDetectionPass();
      await root._handlerDefinitions.get("consumer")!.revalidateAndBuild(
        `${directory}/handlers`,
      );
      cache.commitPendingSourceMtimes();
      const changedName = root._handlerFilenames.get("consumer")!;
      assertNotEquals(changedName, initialName);
      const changedCode = await Deno.readTextFile(
        `${directory}/handlers/${changedName}.js`,
      );
      assertStringIncludes(
        changedCode,
        middle._handlerFilenames.get("forward")!,
      );
      await assertRejects(
        () => Deno.stat(`${directory}/handlers/${initialName}.js`),
        Deno.errors.NotFound,
      );
      cache.beginChangeDetectionPass();
      await root._handlerDefinitions.get("consumer")!.revalidateAndBuild(
        `${directory}/handlers`,
      );
      cache.commitPendingSourceMtimes();
      assertEquals(root._handlerFilenames.get("consumer"), changedName);
    } finally {
      await Deno.remove(directory, { recursive: true });
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "NewHandlers fresh build awaits nested factories and emits executable modules",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/new-handlers";
    const leaf = new NewHandlers(import.meta.url, () => ({
      increment: function (this: { offset: number }, value: number) {
        return this.offset + value;
      },
      unused: function () {
        throw new Error("unused");
      },
    }));
    const middle = new NewHandlers(import.meta.url, async () => {
      const { fn } = await imports(leaf);
      return {
        forward: function (this: { offset: number }, value: number) {
          return fn.increment.call(this, value);
        },
      };
    });
    const root = new NewHandlers(import.meta.url, async () => {
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
      assertEquals(module.default.call({ offset: 10 }, 4), 14);
      const browserGlobals = globalThis as unknown as {
        handlers: Record<string, unknown>;
      };
      assertEquals(browserGlobals.handlers[filename], module.default);
      assertEquals(
        browserGlobals.handlers[leaf._handlerFilenames.get("unused")!],
        undefined,
      );
      assertEquals([...root._handlerFilenames.keys()], ["consumer"]);
    } finally {
      await Deno.remove(directory, { recursive: true });
      reset();
      (await getEsbuild()).stop();
    }
  },
});
