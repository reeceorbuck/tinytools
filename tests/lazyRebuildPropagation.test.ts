/**
 * Tests for lazy-mode handler rebuild propagation across imported files.
 *
 * The dental dev server uses lazy revalidation: a handler is only
 * rehashed/rebuilt when one of its routes is requested. When a handler
 * imports another handler from a different source file, three things
 * must happen on edit of the imported file even when the consumer file
 * itself was not edited:
 *
 *   1. The imported handler is rehashed and renamed first (so that
 *      consumer code references the new filename in its emitted import
 *      statements).
 *   2. The consumer's local import registry is synced to the imported
 *      handler's CURRENT filename.
 *   3. The consumer's OWN filename hash also changes — otherwise the
 *      browser keeps the old cached `consumer_xxxx.js` URL and serves
 *      stale code that points to the old imported filename.
 *
 * These tests construct synthetic source files on disk so the cache's
 * mtime detection logic exercises real fs stat calls, then drive the
 * lazy revalidation pipeline directly via `revalidateAndBuild`.
 *
 * Run with: deno test --allow-all tests/lazyRebuildPropagation.test.ts
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  changedHandlerKeys,
  type ClientFunctionImpl,
  filesWithChangedHandlers,
  getImportRegistry,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import {
  cache,
  Handlers,
  normalizeSourceFileUrl,
  registeredClientTools,
} from "../clientTools.ts";
import {
  changedStyleKeys,
  scopedStylesRegistry,
  styleBundleRegistry,
} from "../scopedStyles.ts";

// ============================================================================
// Test Utilities
// ============================================================================

const TEST_ROOT = "./.test-lazy-rebuild";
const TEST_HANDLER_DIR = `${TEST_ROOT}/handlers`;
const TEST_SRC_DIR = `${TEST_ROOT}/src`;

async function cleanupTestDirs() {
  try {
    await Deno.remove(TEST_ROOT, { recursive: true });
  } catch {
    // not present
  }
}

function resetRegistries() {
  cache.resetHashDependentState();
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  scopedStylesRegistry.clear();
  styleBundleRegistry.clear();
  changedHandlerKeys.clear();
  filesWithChangedHandlers.clear();
  changedStyleKeys.clear();
  registeredClientTools.clear();
  resetImportRegistries();
}

/**
 * Write a fake source file at TEST_SRC_DIR/<name>.tsx containing the
 * given text. Returns the file:// URL string suitable for passing to
 * `new Handlers(...)` as its source file URL.
 *
 * The actual content does not matter for hash/rebuild logic — only the
 * file's mtime is consulted by `cache.checkAndTrackMtimeChange`.
 */
async function writeFakeSource(name: string, body: string): Promise<string> {
  await Deno.mkdir(TEST_SRC_DIR, { recursive: true });
  const path = `${TEST_SRC_DIR}/${name}.tsx`;
  await Deno.writeTextFile(path, body);
  return pathToFileURL(
    `${Deno.cwd()}/${path.replace(/^\.\//, "")}`,
  ).toString();
}

/** Mutate a fake source file so its mtime advances. */
async function touchFakeSource(url: string, body: string): Promise<void> {
  const path = fileURLToPath(url);
  // Wait long enough that filesystems with second-resolution mtime see a
  // distinct value.
  await new Promise((r) => setTimeout(r, 20));
  await Deno.writeTextFile(path, body);
}

/**
 * Locate the registered impl for a function name on a given source url.
 * The registry cast is intentional — these tests poke at the internal
 * pipeline that the dental dev server relies on.
 */
function getImpl(
  sourceUrl: string,
  fnName: string,
): ClientFunctionImpl {
  const normalized = normalizeSourceFileUrl(sourceUrl);
  assertExists(normalized);
  const set = cache.getHandlersForSource(normalized);
  for (const h of set) {
    const impl = h as ClientFunctionImpl;
    if (impl.fnName === fnName) return impl;
  }
  throw new Error(`No impl named ${fnName} on ${sourceUrl}`);
}

/** Read the consumer's emitted handler file and assert it imports `expectedFilename`. */
async function assertConsumerImports(
  consumerFile: string,
  expectedFilename: string,
) {
  const text = await Deno.readTextFile(consumerFile);
  assert(
    text.includes(expectedFilename),
    `Expected consumer file to reference '${expectedFilename}'.\n` +
      `Got:\n${text}`,
  );
}

/**
 * Drive a full lazy revalidation pass for a single handler. Mirrors how
 * `_doEnsureBuilt` invokes the pipeline at request time, including
 * begin/commit pass bookkeeping.
 */
async function lazyRevalidate(impl: ClientFunctionImpl): Promise<boolean> {
  cache.beginChangeDetectionPass();
  try {
    return await impl.revalidateAndBuild(TEST_HANDLER_DIR);
  } finally {
    cache.commitPendingSourceMtimes();
  }
}

// ============================================================================
// Test Suite: imported-handler renames propagate to consumer
// ============================================================================

Deno.test({
  name:
    "lazy rebuild - editing imported file rehashes the imported handler's filename",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const consumerUrl = await writeFakeSource("consumer", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("v1");
      },
    });
    const _consumer = new Handlers(consumerUrl, {
      consumerFn(this: HTMLElement) {
        console.log("calls helper");
      },
    }, { imports: [helper] });
    void _consumer;

    // First build — every handler is "new", so both files must be written.
    const helperImpl = getImpl(helperUrl, "sharedFn");
    const consumerImpl = getImpl(consumerUrl, "consumerFn");
    await lazyRevalidate(helperImpl);
    await lazyRevalidate(consumerImpl);

    const initialHelperFilename = helperImpl.filename;
    assert(initialHelperFilename.startsWith("sharedFn_"));

    // Edit helper.tsx (consumer.tsx untouched). The helper's body changes
    // shape, but the function code captured in the impl does not — what
    // we care about is that the source mtime advancing forces a rehash
    // pass. The hash input still uses `fn.toString()`, which is stable
    // for the JS function in memory; this confirms that an mtime-only
    // edit does NOT rename the helper unless its hash genuinely shifts.
    await touchFakeSource(helperUrl, "// v2");
    // After resetHashDependentState we lost cache.files entries — the
    // existing impls remain registered in handlersBySource via
    // re-registration through revalidate; explicitly re-seed entries to
    // simulate a real persisted cache snapshot loaded at startup.
    cache.files[normalizeSourceFileUrl(helperUrl)!] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { sharedFn: { 0: initialHelperFilename } },
      styles: {},
    };
    cache.files[normalizeSourceFileUrl(consumerUrl)!] ??= {
      mtimeMs: 1,
      externalImports: [
        `${normalizeSourceFileUrl(helperUrl)!}::sharedFn`,
      ],
      handlers: { consumerFn: { 0: consumerImpl.filename } },
      styles: {},
    };

    // Replace the in-memory function body so `fn.toString()` differs and
    // forces a content-driven rename. This mirrors what `deno run` does
    // implicitly when the source file is reloaded — a different closure
    // is captured, with different stringified code.
    (helperImpl as unknown as { fn: () => void }).fn = function sharedFn(
      this: HTMLElement,
    ) {
      console.log("v2 - completely different body");
    };

    await lazyRevalidate(helperImpl);

    assertNotEquals(
      helperImpl.filename,
      initialHelperFilename,
      "helper filename must change when its content hash shifts",
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lazy rebuild - consumer's import registry is synced to imported handler's new filename",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const consumerUrl = await writeFakeSource("consumer", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("v1 body");
      },
    });
    const _consumer = new Handlers(consumerUrl, {
      consumerFn(this: HTMLElement) {
        console.log("consumer v1");
      },
    }, { imports: [helper] });
    void _consumer;

    const helperImpl = getImpl(helperUrl, "sharedFn");
    const consumerImpl = getImpl(consumerUrl, "consumerFn");

    // Initial build pass for both
    await lazyRevalidate(helperImpl);
    await lazyRevalidate(consumerImpl);

    const oldHelperFilename = helperImpl.filename;

    // Mutate helper's function body so its hash genuinely shifts on
    // next revalidate.
    await touchFakeSource(helperUrl, "// v2");
    const helperKey = normalizeSourceFileUrl(helperUrl)!;
    const consumerKey = normalizeSourceFileUrl(consumerUrl)!;
    cache.files[helperKey] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { sharedFn: { 0: oldHelperFilename } },
      styles: {},
    };
    cache.files[consumerKey] ??= {
      mtimeMs: 1,
      externalImports: [`${helperKey}::sharedFn`],
      handlers: { consumerFn: { 0: consumerImpl.filename } },
      styles: {},
    };

    (helperImpl as unknown as { fn: () => void }).fn = function sharedFn(
      this: HTMLElement,
    ) {
      console.log("v2 different body");
    };

    // Drive the consumer's revalidate — its `revalidateExternalImports`
    // hook must walk the helper, rehash it, and update the consumer's
    // local import registry to the helper's new filename.
    await lazyRevalidate(consumerImpl);

    assertNotEquals(
      helperImpl.filename,
      oldHelperFilename,
      "helper should have been rehashed by external-imports walk",
    );

    const consumerRegistry = getImportRegistry(consumerKey);
    assertEquals(
      consumerRegistry.get("sharedFn"),
      helperImpl.filename,
      "consumer's import registry must point at the helper's new filename",
    );

    // The consumer's emitted file must reference the new helper filename.
    const consumerPath = `${TEST_HANDLER_DIR}/${consumerImpl.filename}.js`;
    await assertConsumerImports(consumerPath, helperImpl.filename);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lazy rebuild - consumer's OWN filename changes when an imported handler renames (cache busting)",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const consumerUrl = await writeFakeSource("consumer", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("v1 body");
      },
    });
    const _consumer = new Handlers(consumerUrl, {
      consumerFn(this: HTMLElement) {
        console.log("consumer body — does not change");
      },
    }, { imports: [helper] });
    void _consumer;

    const helperImpl = getImpl(helperUrl, "sharedFn");
    const consumerImpl = getImpl(consumerUrl, "consumerFn");

    await lazyRevalidate(helperImpl);
    await lazyRevalidate(consumerImpl);

    const oldHelperFilename = helperImpl.filename;
    const oldConsumerFilename = consumerImpl.filename;

    // Edit ONLY the helper.
    await touchFakeSource(helperUrl, "// v2");
    const helperKey = normalizeSourceFileUrl(helperUrl)!;
    const consumerKey = normalizeSourceFileUrl(consumerUrl)!;
    cache.files[helperKey] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { sharedFn: { 0: oldHelperFilename } },
      styles: {},
    };
    cache.files[consumerKey] ??= {
      mtimeMs: 1,
      externalImports: [`${helperKey}::sharedFn`],
      handlers: { consumerFn: { 0: oldConsumerFilename } },
      styles: {},
    };

    (helperImpl as unknown as { fn: () => void }).fn = function sharedFn(
      this: HTMLElement,
    ) {
      console.log("v2 totally different body");
    };

    // The consumer's body did NOT change, but its imports did. Its
    // filename hash MUST shift so the browser cannot serve a stale
    // cached `consumer_oldhash.js` that internally references
    // `helper_oldhash.js`.
    await lazyRevalidate(consumerImpl);

    assertNotEquals(
      helperImpl.filename,
      oldHelperFilename,
      "helper must rename",
    );
    assertNotEquals(
      consumerImpl.filename,
      oldConsumerFilename,
      "consumer must also rename so the browser cache busts on the consumer URL",
    );

    // Both new files must exist on disk.
    const helperPath = `${TEST_HANDLER_DIR}/${helperImpl.filename}.js`;
    const consumerPath = `${TEST_HANDLER_DIR}/${consumerImpl.filename}.js`;
    assertExists(await Deno.stat(helperPath));
    assertExists(await Deno.stat(consumerPath));

    // The new consumer file must reference the new helper filename.
    await assertConsumerImports(consumerPath, helperImpl.filename);

    // The OLD on-disk files must have been removed so they cannot be
    // served stale.
    let oldHelperGone = false;
    try {
      await Deno.stat(`${TEST_HANDLER_DIR}/${oldHelperFilename}.js`);
    } catch {
      oldHelperGone = true;
    }
    assert(oldHelperGone, "old helper file should be removed on rename");

    let oldConsumerGone = false;
    try {
      await Deno.stat(`${TEST_HANDLER_DIR}/${oldConsumerFilename}.js`);
    } catch {
      oldConsumerGone = true;
    }
    assert(oldConsumerGone, "old consumer file should be removed on rename");

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "lazy rebuild - no-op when nothing changed (idempotent rebuild pass)",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const consumerUrl = await writeFakeSource("consumer", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("v1");
      },
    });
    const _consumer = new Handlers(consumerUrl, {
      consumerFn(this: HTMLElement) {
        console.log("consumer");
      },
    }, { imports: [helper] });
    void _consumer;

    const helperImpl = getImpl(helperUrl, "sharedFn");
    const consumerImpl = getImpl(consumerUrl, "consumerFn");

    await lazyRevalidate(helperImpl);
    await lazyRevalidate(consumerImpl);

    const helperBefore = helperImpl.filename;
    const consumerBefore = consumerImpl.filename;
    const helperContent = await Deno.readTextFile(
      `${TEST_HANDLER_DIR}/${helperBefore}.js`,
    );
    const consumerContent = await Deno.readTextFile(
      `${TEST_HANDLER_DIR}/${consumerBefore}.js`,
    );

    // Second pass with no source mutations.
    await lazyRevalidate(helperImpl);
    await lazyRevalidate(consumerImpl);

    assertEquals(
      helperImpl.filename,
      helperBefore,
      "helper filename should be stable across no-op rebuild",
    );
    assertEquals(
      consumerImpl.filename,
      consumerBefore,
      "consumer filename should be stable across no-op rebuild",
    );
    assertEquals(
      await Deno.readTextFile(`${TEST_HANDLER_DIR}/${helperBefore}.js`),
      helperContent,
    );
    assertEquals(
      await Deno.readTextFile(`${TEST_HANDLER_DIR}/${consumerBefore}.js`),
      consumerContent,
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lazy rebuild - editing only the consumer file does not rehash the imported helper",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const consumerUrl = await writeFakeSource("consumer", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("helper-v1 body");
      },
    });
    const _consumer = new Handlers(consumerUrl, {
      consumerFn(this: HTMLElement) {
        console.log("consumer v1");
      },
    }, { imports: [helper] });
    void _consumer;

    const helperImpl = getImpl(helperUrl, "sharedFn");
    const consumerImpl = getImpl(consumerUrl, "consumerFn");

    await lazyRevalidate(helperImpl);
    await lazyRevalidate(consumerImpl);
    const helperBefore = helperImpl.filename;
    const consumerBefore = consumerImpl.filename;

    // Edit only consumer.
    await touchFakeSource(consumerUrl, "// v2");
    const helperKey = normalizeSourceFileUrl(helperUrl)!;
    const consumerKey = normalizeSourceFileUrl(consumerUrl)!;
    cache.files[helperKey] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { sharedFn: { 0: helperBefore } },
      styles: {},
    };
    cache.files[consumerKey] ??= {
      mtimeMs: 1,
      externalImports: [`${helperKey}::sharedFn`],
      handlers: { consumerFn: { 0: consumerBefore } },
      styles: {},
    };

    (consumerImpl as unknown as { fn: () => void }).fn = function consumerFn(
      this: HTMLElement,
    ) {
      // Reference the imported `sharedFn` symbol so esbuild does NOT
      // dead-code-eliminate the generated import line. The string is
      // captured into the module scope by the wrapper code emitted in
      // `buildHandlerCode`.
      // @ts-ignore — sharedFn is provided by the emitted import line
      sharedFn();
      console.log("consumer v2 — completely new body");
    };

    await lazyRevalidate(consumerImpl);

    assertNotEquals(
      consumerImpl.filename,
      consumerBefore,
      "consumer must rename when its own body changes",
    );
    assertEquals(
      helperImpl.filename,
      helperBefore,
      "helper must NOT rename when its own source is unchanged",
    );

    // Consumer's emitted file should still reference the (unchanged) helper.
    await assertConsumerImports(
      `${TEST_HANDLER_DIR}/${consumerImpl.filename}.js`,
      helperImpl.filename,
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lazy rebuild - multi-hop import chain cascades renames from leaf to root",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // chain: leaf <- mid <- root
    const leafUrl = await writeFakeSource("leaf", "// v1");
    const midUrl = await writeFakeSource("mid", "// v1");
    const rootUrl = await writeFakeSource("root", "// v1");

    const leaf = new Handlers(leafUrl, {
      leafFn(this: HTMLElement) {
        console.log("leaf v1");
      },
    });
    const mid = new Handlers(midUrl, {
      midFn(this: HTMLElement) {
        console.log("mid v1");
      },
    }, { imports: [leaf] });
    const _root = new Handlers(rootUrl, {
      rootFn(this: HTMLElement) {
        console.log("root v1");
      },
    }, { imports: [mid] });
    void _root;

    const leafImpl = getImpl(leafUrl, "leafFn");
    const midImpl = getImpl(midUrl, "midFn");
    const rootImpl = getImpl(rootUrl, "rootFn");

    // Initial build for all three.
    await lazyRevalidate(leafImpl);
    await lazyRevalidate(midImpl);
    await lazyRevalidate(rootImpl);

    const leafBefore = leafImpl.filename;
    const midBefore = midImpl.filename;
    const rootBefore = rootImpl.filename;

    // Edit ONLY the leaf.
    await touchFakeSource(leafUrl, "// v2");
    const leafKey = normalizeSourceFileUrl(leafUrl)!;
    const midKey = normalizeSourceFileUrl(midUrl)!;
    const rootKey = normalizeSourceFileUrl(rootUrl)!;
    cache.files[leafKey] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { leafFn: { 0: leafBefore } },
      styles: {},
    };
    cache.files[midKey] ??= {
      mtimeMs: 1,
      externalImports: [`${leafKey}::leafFn`],
      handlers: { midFn: { 0: midBefore } },
      styles: {},
    };
    cache.files[rootKey] ??= {
      mtimeMs: 1,
      externalImports: [`${midKey}::midFn`],
      handlers: { rootFn: { 0: rootBefore } },
      styles: {},
    };

    (leafImpl as unknown as { fn: () => void }).fn = function leafFn(
      this: HTMLElement,
    ) {
      console.log("leaf v2 totally different");
    };

    // Request only the root — the cascade must propagate through mid
    // down to leaf and back up.
    await lazyRevalidate(rootImpl);

    assertNotEquals(leafImpl.filename, leafBefore, "leaf must rename");
    assertNotEquals(midImpl.filename, midBefore, "mid must rename");
    assertNotEquals(rootImpl.filename, rootBefore, "root must rename");

    // The whole chain must reference the new downstream filenames.
    await assertConsumerImports(
      `${TEST_HANDLER_DIR}/${midImpl.filename}.js`,
      leafImpl.filename,
    );
    await assertConsumerImports(
      `${TEST_HANDLER_DIR}/${rootImpl.filename}.js`,
      midImpl.filename,
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lazy rebuild - sibling consumer that does NOT import the helper is unaffected",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const importerUrl = await writeFakeSource("importer", "// v1");
    const independentUrl = await writeFakeSource("independent", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("helper v1");
      },
    });
    const _importer = new Handlers(importerUrl, {
      importerFn(this: HTMLElement) {
        console.log("importer body");
      },
    }, { imports: [helper] });
    const _independent = new Handlers(independentUrl, {
      independentFn(this: HTMLElement) {
        console.log("independent — never imports helper");
      },
    });
    void _importer;
    void _independent;

    const helperImpl = getImpl(helperUrl, "sharedFn");
    const importerImpl = getImpl(importerUrl, "importerFn");
    const independentImpl = getImpl(independentUrl, "independentFn");

    await lazyRevalidate(helperImpl);
    await lazyRevalidate(importerImpl);
    await lazyRevalidate(independentImpl);

    const helperBefore = helperImpl.filename;
    const importerBefore = importerImpl.filename;
    const independentBefore = independentImpl.filename;

    // Edit helper.
    await touchFakeSource(helperUrl, "// v2");
    const helperKey = normalizeSourceFileUrl(helperUrl)!;
    const importerKey = normalizeSourceFileUrl(importerUrl)!;
    const independentKey = normalizeSourceFileUrl(independentUrl)!;
    cache.files[helperKey] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { sharedFn: { 0: helperBefore } },
      styles: {},
    };
    cache.files[importerKey] ??= {
      mtimeMs: 1,
      externalImports: [`${helperKey}::sharedFn`],
      handlers: { importerFn: { 0: importerBefore } },
      styles: {},
    };
    cache.files[independentKey] ??= {
      mtimeMs: 1,
      externalImports: [],
      handlers: { independentFn: { 0: independentBefore } },
      styles: {},
    };

    (helperImpl as unknown as { fn: () => void }).fn = function sharedFn(
      this: HTMLElement,
    ) {
      console.log("helper v2 different");
    };

    await lazyRevalidate(importerImpl);
    await lazyRevalidate(independentImpl);

    assertNotEquals(helperImpl.filename, helperBefore);
    assertNotEquals(importerImpl.filename, importerBefore);
    assertEquals(
      independentImpl.filename,
      independentBefore,
      "an independent handler that does not import helper must not rename",
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lazy rebuild - externalImports is populated by `imports` option even on first build",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    const helperUrl = await writeFakeSource("helper", "// v1");
    const consumerUrl = await writeFakeSource("consumer", "// v1");

    const helper = new Handlers(helperUrl, {
      sharedFn(this: HTMLElement) {
        console.log("v1");
      },
    });
    const _consumer = new Handlers(consumerUrl, {
      consumerFn(this: HTMLElement) {
        console.log("consumer");
      },
    }, { imports: [helper] });
    void _consumer;

    // Without any rebuild pass having run, the consumer's cache entry
    // must already contain the externalImports key — otherwise
    // revalidateExternalImports has nothing to walk on the very first
    // request and the propagation chain breaks for fresh-start dev
    // sessions.
    const consumerKey = normalizeSourceFileUrl(consumerUrl)!;
    const consumerEntry = cache.files[consumerKey];
    assertExists(consumerEntry);
    const helperKey = normalizeSourceFileUrl(helperUrl)!;
    const expectedImportKey = `${helperKey}::sharedFn`;
    assert(
      consumerEntry.externalImports.includes(expectedImportKey),
      "consumer.externalImports should include the helper key after construction. " +
        `Got: ${JSON.stringify(consumerEntry.externalImports)}`,
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
