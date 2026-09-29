/**
 * Tests for lazy-mode rebuild propagation between handler bundles.
 *
 * The dev server builds handler bundles on demand. Bundle filenames are
 * content hashes over the bundle and everything it (transitively) imports,
 * so when an imported bundle changes:
 *
 *   1. The imported bundle gets a new filename.
 *   2. Every consumer's emitted file imports that new filename.
 *   3. Every consumer's OWN filename also changes, so browsers never keep a
 *      cached consumer pointing at the old import.
 *
 * Bundles outside the changed import graph keep their filenames.
 *
 * Run with: deno test --allow-all tests/lazyRebuildPropagation.test.ts
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { pathToFileURL } from "node:url";
import {
  changedHandlerKeys,
  filesWithChangedHandlers,
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import { cache, Handlers, registeredClientTools } from "../clientTools.ts";
import {
  changedStyleKeys,
  scopedStylesRegistry,
  styleBundleRegistry,
} from "../scopedStyles.ts";

const TEST_ROOT = "./.test-lazy-rebuild";
const TEST_HANDLER_DIR = `${TEST_ROOT}/handlers`;
const TEST_SRC_DIR = `${TEST_ROOT}/src`;

type Tools = InstanceType<typeof Handlers>;

async function cleanupTestDirs() {
  await Deno.remove(TEST_ROOT, { recursive: true }).catch(() => {});
}

function resetRegistries() {
  cache.resetHashDependentState();
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  scopedStylesRegistry.clear();
  styleBundleRegistry.clear();
  changedHandlerKeys.clear();
  filesWithChangedHandlers.clear();
  changedStyleKeys.clear();
  registeredClientTools.clear();
  resetImportRegistries();
}

/** Write a fake source file and return its file:// URL. */
async function writeFakeSource(name: string): Promise<string> {
  await Deno.mkdir(TEST_SRC_DIR, { recursive: true });
  const path = `${TEST_SRC_DIR}/${name}.tsx`;
  await Deno.writeTextFile(path, "// source");
  return pathToFileURL(`${Deno.cwd()}/${path.replace(/^\.\//, "")}`)
    .toString();
}

/** Drive one lazy pass for the given tools, as `ensureBuilt` does per request. */
async function lazyRevalidate(...tools: Tools[]): Promise<void> {
  cache.beginChangeDetectionPass();
  try {
    for (const tool of tools) {
      for (const impl of tool._handlerDefinitions.values()) {
        await impl.bundle.ensureWritten(TEST_HANDLER_DIR);
      }
    }
  } finally {
    cache.commitPendingSourceMtimes();
  }
}

/** Swap a handler's function, as a reloaded module would. */
function edit(tool: Tools, name: string, fn: () => void) {
  tool._handlerDefinitions.get(name)!.fn = fn;
}

const filename = (tool: Tools, name: string) =>
  tool._handlerFilenames.get(name)!;

async function readBundle(tool: Tools, name: string): Promise<string> {
  return await Deno.readTextFile(
    `${TEST_HANDLER_DIR}/${filename(tool, name)}.js`,
  );
}

async function exists(file: string): Promise<boolean> {
  return await Deno.stat(`${TEST_HANDLER_DIR}/${file}.js`).then(
    () => true,
    () => false,
  );
}

async function helperAndConsumer() {
  const helper = new Handlers(await writeFakeSource("helper"), {
    sharedFn(this: HTMLElement) {
      console.log("v1");
    },
  });
  const consumer = new Handlers(
    await writeFakeSource("consumer"),
    { imports: [helper] },
    {
      consumerFn(this: HTMLElement) {
        // @ts-ignore - sharedFn is provided by the emitted import
        sharedFn();
      },
    },
  );
  return { helper, consumer };
}

function lazyTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `lazy rebuild - ${name}`,
    async fn() {
      await cleanupTestDirs();
      resetRegistries();
      try {
        await fn();
      } finally {
        await cleanupTestDirs();
      }
    },
    sanitizeOps: false,
    sanitizeResources: false,
  });
}

lazyTest("editing an imported file renames the imported bundle", async () => {
  const { helper, consumer } = await helperAndConsumer();
  await lazyRevalidate(consumer);
  const initial = filename(helper, "sharedFn");
  assert(initial.startsWith("helper_"));

  edit(helper, "sharedFn", function sharedFn() {
    console.log("v2 - completely different body");
  });
  await lazyRevalidate(consumer);

  assertNotEquals(filename(helper, "sharedFn"), initial);
  assert(await exists(filename(helper, "sharedFn")));
  assertEquals(await exists(initial), false, "stale helper bundle removed");
});

lazyTest(
  "consumer imports the new helper filename and is itself renamed",
  async () => {
    const { helper, consumer } = await helperAndConsumer();
    await lazyRevalidate(consumer);
    const initialConsumer = filename(consumer, "consumerFn");
    assert(initialConsumer.startsWith("consumer_"));
    assert(
      (await readBundle(consumer, "consumerFn")).includes(
        `./${filename(helper, "sharedFn")}.js`,
      ),
    );

    edit(helper, "sharedFn", function sharedFn() {
      console.log("v2 different body");
    });
    await lazyRevalidate(consumer);

    assertNotEquals(filename(consumer, "consumerFn"), initialConsumer);
    assert(
      (await readBundle(consumer, "consumerFn")).includes(
        `./${filename(helper, "sharedFn")}.js`,
      ),
    );
    assertEquals(await exists(initialConsumer), false);
  },
);

lazyTest("no-op when nothing changed (idempotent rebuild pass)", async () => {
  const { helper, consumer } = await helperAndConsumer();
  await lazyRevalidate(consumer);
  const before = [
    filename(helper, "sharedFn"),
    filename(consumer, "consumerFn"),
  ];
  const contents = await readBundle(consumer, "consumerFn");

  changedHandlerKeys.clear();
  await lazyRevalidate(consumer);
  await lazyRevalidate(consumer, helper);

  assertEquals(
    [filename(helper, "sharedFn"), filename(consumer, "consumerFn")],
    before,
  );
  assertEquals(await readBundle(consumer, "consumerFn"), contents);
  assertEquals(changedHandlerKeys.size, 0);
});

lazyTest("editing only the consumer does not rename the helper", async () => {
  const { helper, consumer } = await helperAndConsumer();
  await lazyRevalidate(consumer);
  const helperName = filename(helper, "sharedFn");
  const consumerName = filename(consumer, "consumerFn");

  edit(consumer, "consumerFn", function consumerFn() {
    // @ts-ignore - provided by the emitted import
    sharedFn();
    console.log("edited consumer");
  });
  await lazyRevalidate(consumer);

  assertEquals(filename(helper, "sharedFn"), helperName);
  assertNotEquals(filename(consumer, "consumerFn"), consumerName);
});

lazyTest(
  "multi-hop import chain cascades renames from leaf to root",
  async () => {
    const leaf = new Handlers(await writeFakeSource("leaf"), {
      leafFn() {
        return "leaf v1";
      },
    });
    const middle = new Handlers(
      await writeFakeSource("middle"),
      { imports: [leaf] },
      {
        middleFn() {
          // @ts-ignore - provided by the emitted import
          return leafFn();
        },
      },
    );
    const root = new Handlers(
      await writeFakeSource("root"),
      { imports: [middle] },
      {
        rootFn() {
          // @ts-ignore - provided by the emitted import
          return middleFn();
        },
      },
    );
    await lazyRevalidate(root);
    const before = {
      leaf: filename(leaf, "leafFn"),
      middle: filename(middle, "middleFn"),
      root: filename(root, "rootFn"),
    };

    edit(leaf, "leafFn", function leafFn() {
      return "leaf v2";
    });
    await lazyRevalidate(root);

    assertNotEquals(filename(leaf, "leafFn"), before.leaf);
    assertNotEquals(filename(middle, "middleFn"), before.middle);
    assertNotEquals(filename(root, "rootFn"), before.root);
    assert(
      (await readBundle(middle, "middleFn")).includes(filename(leaf, "leafFn")),
    );
    assert(
      (await readBundle(root, "rootFn")).includes(filename(middle, "middleFn")),
    );
  },
);

lazyTest(
  "a consumer that does NOT import the helper is unaffected",
  async () => {
    const { helper, consumer } = await helperAndConsumer();
    const bystander = new Handlers(
      await writeFakeSource("bystander"),
      { imports: [helper] },
      {
        bystanderFn() {
          console.log("never calls the helper");
        },
      },
    );
    await lazyRevalidate(consumer, bystander);
    const bystanderName = filename(bystander, "bystanderFn");

    edit(helper, "sharedFn", function sharedFn() {
      console.log("v2");
    });
    await lazyRevalidate(consumer, bystander);

    assertEquals(filename(bystander, "bystanderFn"), bystanderName);
    assertEquals(
      (await readBundle(bystander, "bystanderFn")).includes("helper_"),
      false,
    );
  },
);

lazyTest(
  "in-file sibling bundles reach each other by name and cascade renames",
  async () => {
    const shared = await writeFakeSource("shared");
    const leaf = new Handlers(shared, {
      leafFn() {
        return "leaf v1";
      },
    });
    const middle = new Handlers(shared, {
      middleFn() {
        // @ts-ignore - provided by the emitted import
        return leafFn();
      },
    });
    const unrelated = new Handlers(shared, {
      unrelatedFn() {
        return "unrelated";
      },
    });
    const external = new Handlers(
      await writeFakeSource("external"),
      { imports: [middle] },
      {
        externalFn() {
          // @ts-ignore - provided by the emitted import
          return middleFn();
        },
      },
    );
    await lazyRevalidate(external, unrelated);
    const before = {
      middle: filename(middle, "middleFn"),
      unrelated: filename(unrelated, "unrelatedFn"),
      external: filename(external, "externalFn"),
    };
    assert(
      (await readBundle(middle, "middleFn")).includes(filename(leaf, "leafFn")),
    );

    edit(leaf, "leafFn", function leafFn() {
      return "leaf v2";
    });
    await lazyRevalidate(external, unrelated);

    assertNotEquals(filename(middle, "middleFn"), before.middle);
    assertNotEquals(filename(external, "externalFn"), before.external);
    assertEquals(filename(unrelated, "unrelatedFn"), before.unrelated);
  },
);

lazyTest("bundles that import each other hash and build", async () => {
  const shared = await writeFakeSource("cycle");
  const ping = new Handlers(shared, {
    ping(count: number): number {
      // @ts-ignore - provided by the emitted import
      return count > 0 ? pong(count - 1) : 0;
    },
  });
  const pong = new Handlers(shared, {
    pong(count: number): number {
      // @ts-ignore - provided by the emitted import
      return count > 0 ? ping(count - 1) + 1 : 0;
    },
  });
  await lazyRevalidate(ping, pong);
  assert((await readBundle(ping, "ping")).includes(filename(pong, "pong")));
  assert((await readBundle(pong, "pong")).includes(filename(ping, "ping")));
  const module = await import(
    pathToFileURL(
      `${Deno.cwd()}/${TEST_HANDLER_DIR}/${filename(ping, "ping")}.js`,
    ).href
  );
  assertEquals(module.ping(4), 2);
});
