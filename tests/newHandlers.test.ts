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
  registeredClientTools,
  Signals,
  Store,
  Styles,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import { handlers, resetImportRegistries } from "../clientFunctions.ts";
import type { JSX } from "../jsx-runtime.ts";
import { handlerReferenceAttributes } from "../eventAttributes.ts";

declare const stored: { count?: number };

Deno.test({
  name:
    "signal namespace retains only used dependencies and stays separate from fn",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    try {
      const result = await compileHandlerNamespace(
        "function () { return signal.count().value + fn.count(); }",
        "consume",
        "consume",
        new Map([
          ["signal:count", "./signal_count.js"],
          ["signal:unused", "./unused.js"],
          ["count", "./handler_count.js"],
        ]),
      );
      assertEquals(result.imports.sort(), [
        "./handler_count.js",
        "./signal_count.js",
      ]);
      assertStringIncludes(result.code, "signal.count()");
      assertStringIncludes(result.code, "fn.count()");
      assertStringIncludes(
        result.code,
        'import signal1 from "./signal_count.js"',
      );
      assertEquals(result.code.includes("__tinyDependency"), false);
      const collision = await compileHandlerNamespace(
        "function () { return signal.count().value + fn.signal(); }",
        "signal",
        "collision",
        new Map([["signal:count", "./signal_count.js"], [
          "signal",
          "./handler_signal.js",
        ]]),
      );
      assertEquals(collision.imports.sort(), [
        "./handler_signal.js",
        "./signal_count.js",
      ]);
      assertStringIncludes(
        collision.code,
        'import count from "./signal_count.js"',
      );
      const numbered = await compileHandlerNamespace(
        "function () { const signal1 = 1; return signal['not-valid']().value + signal.fn().value + signal1; }",
        "consume",
        "numbered",
        new Map([
          ["signal:not-valid", "./invalid.js"],
          ["signal:fn", "./reserved.js"],
        ]),
      );
      assertStringIncludes(numbered.code, 'import signal2 from "./invalid.js"');
      assertStringIncludes(
        numbered.code,
        'import signal3 from "./reserved.js"',
      );
    } finally {
      (await getEsbuild()).stop();
    }
  },
});

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

Deno.test({
  name:
    "Signals factories emit stored accessors with shared computed dependencies",
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
          return [signal.count(), signal.doubled(), signal.empty()];
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
      const module = await load(consumer._handlerFilenames.get("read")!);
      const [count, doubled, empty] = module.default();
      assertEquals(count.value, 1);
      assertEquals(doubled.value, 2);
      assertEquals(empty.value, null);
      assertEquals(module.default()[0], count);
      const target = new EventTarget();
      const values: number[] = [];
      target.addEventListener(
        "signal",
        (event) => values.push((event as Event & { value: number }).value),
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
      assertEquals(other.default().value, 1);
      assertNotEquals(other.default(), count);
      const textModule = await load(first._handlerFilenames.get("text")!);
      const input = Object.assign(new EventTarget(), { value: "typed" });
      input.addEventListener(
        "input",
        (event) => textModule.default.call(input, event),
      );
      input.dispatchEvent(new Event("input"));
      assertEquals(textModule.default().value, "typed");
      const subscriber = Object.assign(new EventTarget(), {
        abortController: new AbortController(),
      });
      let notifications = 0;
      subscriber.addEventListener("signal", () => notifications++);
      textModule.default.call(subscriber, new Event("load"));
      textModule.default.call(subscriber, new Event("load"));
      textModule.default().value = "first";
      assertEquals(notifications, 1);
      subscriber.abortController.abort();
      textModule.default().value = "second";
      assertEquals(notifications, 1);
      subscriber.abortController = new AbortController();
      textModule.default.call(subscriber, new Event("load"));
      textModule.default().value = "third";
      assertEquals(notifications, 2);
      const references = await imports(first);
      assertEquals(typeof references.signal.count, "object");
      assertEquals((references.fn as Record<string, unknown>).count, undefined);
      assertEquals(
        handlerReferenceAttributes("onInput", references.signal.text),
        {
          oninput: "tiny.runHandler(this,event)",
          "tt-handler-input": first._handlerFilenames.get("text")!,
        },
      );
      const checkTypes = () => {
        const value: number = references.signal.count().value;
        // @ts-expect-error Signals are not ordinary fn handlers.
        references.fn.count();
        // @ts-expect-error Computed values cannot be assigned.
        references.signal.doubled().value = 3;
        // @ts-expect-error Signal factories cannot return handlers.
        new Signals(import.meta.url, () => ({ bad: () => 1 }));
        return value;
      };
      void checkTypes;
      const checkMixedImports = async () => {
        const styles = new Styles(import.meta.url, { section: "color: red;" });
        const { fn, signal, styled } = await imports(consumer, styles, first);
        const section: string = styled.section;
        const count: number = signal.count().value;
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
      (async () => ({})) as never,
    );
    await assertRejects(
      () => asynchronous.ensureDefined(),
      TypeError,
      "synchronously",
    );
    const readsValue = new Signals(import.meta.url, ({ Signal }) => {
      const value = new Signal(1);
      void value.value;
      return { value };
    });
    await assertRejects(
      () => readsValue.ensureDefined(),
      Error,
      "only available in client handlers",
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
    "stateful handler modules retain private state until a fresh module loads",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const registry = globalThis as typeof globalThis & {
      handlers?: Record<string, unknown>;
    };
    const previousHandlers = registry.handlers;
    try {
      registry.handlers = {};
      const compile = (filename: string) =>
        compileHandlerNamespace(
          "function() { stored.count ??= 0; return ++stored.count; }",
          "counter",
          filename,
          new Map(),
          undefined,
          true,
        );
      const first = await compile("first_store");
      const second = await compile("second_store");
      const load = (code: string, filename: string) =>
        import(`data:text/javascript,${encodeURIComponent(code)}#${filename}`);
      const firstModule = await load(first.code, "first_store");
      assertEquals(firstModule.default(), 1);
      assertEquals(firstModule.default(), 2);
      assertEquals((await load(first.code, "first_store")).default(), 3);
      assertEquals((await load(second.code, "second_store")).default(), 1);
      assertEquals(first.imports, []);
      assertEquals(Object.hasOwn(globalThis, "stored"), false);
    } finally {
      if (previousHandlers === undefined) delete registry.handlers;
      else registry.handlers = previousHandlers;
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "Store factories emit typed private state and work through fn imports",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    let definitions = 0;
    const create = () =>
      new Store(import.meta.url, (stored: { count?: number }) => {
        definitions++;
        return {
          counter: function (step = 1) {
            stored.count ??= 0;
            return stored.count += step;
          },
          other: function () {
            return stored.count;
          },
        };
      });
    const first = create();
    const second = create();
    const consumer = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(first);
      return {
        increment: function () {
          return fn.counter(2);
        },
      };
    });
    const registry = globalThis as typeof globalThis & {
      handlers?: Record<string, unknown>;
    };
    const previousHandlers = registry.handlers;
    try {
      registry.handlers = {};
      await Promise.all([
        consumer.ensureDefined(),
        first.ensureDefined(),
        second.ensureDefined(),
      ]);
      assertEquals(definitions, 2);
      const reference: (step?: number) => number =
        first.getFunctionReferences.counter;
      assertEquals(typeof reference, "string");
      const firstHandler = first._handlerDefinitions.get("counter")!;
      const secondHandler = second._handlerDefinitions.get("counter")!;
      assertNotEquals(firstHandler.filename, secondHandler.filename);
      const load = async (collection: typeof first, name: string) => {
        const handler = collection._handlerDefinitions.get(name)!;
        const code = await handler.buildCode();
        return await import(
          `data:text/javascript,${encodeURIComponent(code)}#${handler.filename}`
        );
      };
      const firstModule = await load(first, "counter");
      assertEquals(firstModule.default(), 1);
      assertEquals(firstModule.default(2), 3);
      assertEquals((await load(second, "counter")).default(), 1);
      assertEquals((await load(first, "other")).default(), undefined);
      const createWithoutUrl = () =>
        new Store({
          counter: function () {
            stored.count ??= 0;
            return ++stored.count;
          },
        });
      assertNotEquals(
        createWithoutUrl()._handlerFilenames.get("counter"),
        createWithoutUrl()._handlerFilenames.get("counter"),
      );
      const consumerCode = await consumer._handlerDefinitions.get("increment")!
        .buildCode();
      assertStringIncludes(consumerCode, firstHandler.filename);
      assertEquals(consumerCode.includes("Object.create(null)"), false);
    } finally {
      if (previousHandlers === undefined) delete registry.handlers;
      else registry.handlers = previousHandlers;
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "Store builds share state across consumers and isolate object-form stores",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/stores";
    const create = () =>
      new Store(import.meta.url, {
        counter: function () {
          stored.count ??= 0;
          return ++stored.count;
        },
      });
    const first = create();
    const second = create();
    const ordinary = new Handlers(import.meta.url, {
      counter: function () {
        stored.count ??= 0;
        return ++stored.count;
      },
    });
    const wrapper = new Store(
      import.meta.url,
      async (stored: { calls?: number }) => {
        const { fn } = await imports(first);
        return {
          next: function () {
            stored.calls ??= 0;
            return [++stored.calls, fn.counter()];
          },
        };
      },
    );
    const consumer = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(first);
      return {
        next: function () {
          return fn.counter();
        },
      };
    });
    const registry = globalThis as typeof globalThis & {
      handlers?: Record<string, unknown>;
    };
    const previousHandlers = registry.handlers;
    try {
      registry.handlers = {};
      await buildScriptFiles({ fresh: true, publicDir: directory });
      assertNotEquals(
        first._handlerFilenames.get("counter"),
        second._handlerFilenames.get("counter"),
      );
      assertNotEquals(
        first._handlerFilenames.get("counter"),
        ordinary._handlerFilenames.get("counter"),
      );
      const load = (filename: string) =>
        import(
          pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${filename}.js`)
            .href
        );
      const wrapperModule = await load(wrapper._handlerFilenames.get("next")!);
      const consumerModule = await load(
        consumer._handlerFilenames.get("next")!,
      );
      assertEquals(wrapperModule.default(), [1, 1]);
      assertEquals(consumerModule.default(), 2);
      assertEquals(wrapperModule.default(), [2, 3]);
      assertEquals(
        (await load(second._handlerFilenames.get("counter")!)).default(),
        1,
      );
      const initialName = wrapper._handlerFilenames.get("next")!;
      cache.beginChangeDetectionPass();
      await wrapper._handlerDefinitions.get("next")!.revalidateAndBuild(
        `${directory}/handlers`,
      );
      cache.commitPendingSourceMtimes();
      assertEquals(wrapper._handlerFilenames.get("next"), initialName);
      first._handlerDefinitions.get("counter")!.fn = function () {
        stored.count ??= 100;
        return ++stored.count;
      };
      cache.files[first._handlerDefinitions.get("counter")!.sourceFileUrl!]
        .mtimeMs = 0;
      cache.beginChangeDetectionPass();
      await wrapper._handlerDefinitions.get("next")!.revalidateAndBuild(
        `${directory}/handlers`,
      );
      cache.commitPendingSourceMtimes();
      const changedName = wrapper._handlerFilenames.get("next")!;
      assertNotEquals(changedName, initialName);
      assertEquals((await load(changedName)).default(), [1, 101]);
    } finally {
      if (previousHandlers === undefined) delete registry.handlers;
      else registry.handlers = previousHandlers;
      await Deno.remove(directory, { recursive: true });
      reset();
      (await getEsbuild()).stop();
    }
  },
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
      // @ts-expect-error imported handlers remain private through run
      collection.run.used;
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
        if (body.includes("fn.")) {
          assertStringIncludes(result.code, "const fn = { used }");
          assertStringIncludes(result.code, "fn.used");
        }
        if (body.includes("fn.used.call")) {
          assertStringIncludes(result.code, "fn.used.call(this, event)");
        }
        assertEquals(result.code.includes("globalThis.handlers"), false);
        assertEquals(result.code.includes("_handler"), false);
        assertEquals(result.code.includes("consumer_default"), false);
        if (body.startsWith("function")) {
          assertStringIncludes(
            result.code,
            "export default function consumer(",
          );
        }
      }
      const dynamic = await compileHandlerNamespace(
        "function(name, event) { return fn[name](event); }",
        "consumer",
        "consumer_hash",
        dependencies,
      );
      assertEquals(dynamic.imports.sort(), [...dependencies.values()].sort());
      assertStringIncludes(dynamic.code, "fn[name](event)");
      for (
        const [source, expected, declaration] of [
          [
            "async function(value) { return value + 1; }",
            42,
            "async function consumer",
          ],
          ["function*(value) { yield value + 1; }", 42, "function* consumer"],
          [
            "function recurse(value) { return value ? recurse(value - 1) + 1 : 0; }",
            41,
            "function recurse",
          ],
          ["value => value + 1", 42, "=>"],
          ["function(value) { return fn.used(value); }", 42, "export default"],
        ] as const
      ) {
        const result = await compileHandlerNamespace(
          source,
          source.includes("fn.used") ? "fn" : "consumer",
          "default_export_test",
          new Map([[
            "used",
            "data:text/javascript,export default value => value + 1",
          ]]),
        );
        assertStringIncludes(result.code, declaration);
        assertEquals(result.code.includes("_handler"), false);
        const module = await import(
          `data:text/javascript,${encodeURIComponent(result.code)}`
        );
        const value = await module.default(41);
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
          const exportName of [
            "used",
            "fn",
            "_handler",
            "default",
            "some-handler",
            "__proto__",
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
    assertThrows(() => cycleA.getFunctionReferences, Error, "not ready");
    reset();
  },
});

Deno.test({
  name:
    "Handlers keeps concurrent same-file collections isolated and supports legacy consumers",
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
      const { fn, handlers: legacy } = await imports(collection);
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
      assertEquals(typeof legacy.click, "string");
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
    "Handlers lazy rebuild hashes track used dependencies only through multiple hops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/new-handler-rebuild";
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
      assertEquals(module.default.call({ offset: 10 }, 4), 14);
      const browserGlobals = globalThis as unknown as {
        handlers?: Record<string, unknown>;
      };
      assertEquals(browserGlobals.handlers, undefined);
      assertEquals([...root._handlerFilenames.keys()], ["consumer"]);
    } finally {
      await Deno.remove(directory, { recursive: true });
      reset();
      (await getEsbuild()).stop();
    }
  },
});
