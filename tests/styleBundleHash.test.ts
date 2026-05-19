/**
 * Tests for tiny.Styles() bundled CSS filename hashing.
 *
 * Bundle filenames must be unique to the full CSS content of the bundle
 * — every distinct set/sequence of constituent style content must yield
 * a distinct bundle filename because the browser caches assets
 * immutably by URL. Specifically:
 *
 *   1. Editing a style's CSS body (e.g. changing a z-index value) must
 *      change the bundle filename.
 *   2. Adding a style key must change the bundle filename.
 *   3. Removing a style key must change the bundle filename.
 *   4. The bundle filename must not depend on declaration ORDER (sorted),
 *      but MUST react to any genuine change in either the set of keys
 *      or any individual style's content.
 *
 * The tests simulate the dental dev-server flow: each "process load"
 * preserves the on-disk cache (`cache.files`) but starts with cleared
 * in-memory registries — this matches how `deno --watch` restarts the
 * process on each file save and reloads cache.json from disk.
 *
 * Run with: deno test --allow-all tests/styleBundleHash.test.ts
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { pathToFileURL } from "node:url";
import {
  cache,
  normalizeSourceFileUrl,
  registeredClientTools,
  Styles,
} from "../clientTools.ts";
import {
  changedStyleKeys,
  css,
  scopedStylesRegistry,
  styleBundleRegistry,
} from "../scopedStyles.ts";
import {
  changedHandlerKeys,
  filesWithChangedHandlers,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";

const TEST_ROOT = "./.test-style-bundle-hash";
const TEST_SRC_DIR = `${TEST_ROOT}/src`;
const TEST_STYLES_DIR = `${TEST_ROOT}/public/styles`;

async function cleanupTestDirs() {
  try {
    await Deno.remove(TEST_ROOT, { recursive: true });
  } catch {
    // not present
  }
}

/** Full reset — wipes cache + registries, simulating a fresh install. */
function fullReset() {
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
 * Simulate a process restart: preserve `cache.files` (representing the
 * on-disk cache.json snapshot) and the hash config, but clear every
 * in-memory registry and per-pass tracker.
 */
function simulateProcessRestart() {
  // Snapshot persistent cache state
  const filesSnapshot: typeof cache.files = JSON.parse(
    JSON.stringify(cache.files),
  );

  // Clear in-memory registries that should not survive a process restart
  scopedStylesRegistry.clear();
  styleBundleRegistry.clear();
  changedStyleKeys.clear();
  changedHandlerKeys.clear();
  filesWithChangedHandlers.clear();
  handlers.clear();
  registeredClientTools.clear();
  resetImportRegistries();

  // Clear per-pass state that would be reset by a new process
  // (nameOccurrences and per-pass sets)
  // deno-lint-ignore no-explicit-any
  (cache as any).nameOccurrences.clear();
  // deno-lint-ignore no-explicit-any
  (cache as any).sourceFileMtimeMemo.clear();
  // deno-lint-ignore no-explicit-any
  (cache as any).filesWithMtimeChange.clear();
  // deno-lint-ignore no-explicit-any
  (cache as any).handlersBySource.clear();
  // deno-lint-ignore no-explicit-any
  (cache as any).stylesBySource.clear();
  // deno-lint-ignore no-explicit-any
  (cache as any).processedHandlersThisPass = new WeakSet();
  // deno-lint-ignore no-explicit-any
  (cache as any).processedStylesThisPass = new WeakSet();
  // deno-lint-ignore no-explicit-any
  (cache as any).passDepth = 0;

  // Restore the persistent files map (this is what cache.json reload does)
  cache.files = filesSnapshot;
  (cache as { trustCache: boolean }).trustCache = false;
}

async function writeFakeSource(name: string, body: string): Promise<string> {
  await Deno.mkdir(TEST_SRC_DIR, { recursive: true });
  const path = `${TEST_SRC_DIR}/${name}.tsx`;
  await Deno.writeTextFile(path, body);
  return pathToFileURL(
    `${Deno.cwd()}/${path.replace(/^\.\//, "")}`,
  ).toString();
}

async function touchFakeSource(url: string, body: string): Promise<void> {
  // Wait long enough to defeat FS mtime granularity (Windows NTFS can
  // round to ~10ms; FAT to 2s — 1.2s is safe on every CI runner we use)
  await new Promise((r) => setTimeout(r, 1200));
  const path = url.startsWith("file://") ? new URL(url).pathname : url;
  // strip leading slash on Windows file URLs (file:///C:/...)
  const normalized = Deno.build.os === "windows" && path.startsWith("/")
    ? path.slice(1)
    : path;
  await Deno.writeTextFile(normalized, body);
}

/** Drive ensureBuilt() and return the resolved bundle filename for the first own style. */
async function buildAndGetBundleFilename(
  // deno-lint-ignore no-explicit-any
  tools: any,
  firstOwnStyleName: string,
): Promise<string> {
  await tools.ensureBuilt();
  const filename = tools.styleFilenames.get(firstOwnStyleName) as
    | string
    | undefined;
  if (!filename) throw new Error("No bundle filename resolved");
  return filename;
}

// ============================================================================

Deno.test({
  name:
    "style bundle hash - editing a single CSS value across process restart produces a new bundle filename",
  async fn() {
    await cleanupTestDirs();
    fullReset();

    const sourceUrl = await writeFakeSource("singleValueEdit", "// v1");

    // ---- Process load 1: foo with z-index 1 ----
    const tools1 = new Styles(sourceUrl, {
      foo: css`
        z-index: 1;
      `,
    });
    const bundle1 = await buildAndGetBundleFilename(tools1, "foo");

    // ---- Edit the source file (mtime advances) ----
    await touchFakeSource(sourceUrl, "// v2");

    // ---- Process load 2: foo with z-index 2 ----
    simulateProcessRestart();
    const tools2 = new Styles(sourceUrl, {
      foo: css`
        z-index: 2;
      `,
    });
    const bundle2 = await buildAndGetBundleFilename(tools2, "foo");

    assertNotEquals(
      bundle2,
      bundle1,
      "Bundle filename must change when a style's CSS content changes across a process restart",
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "style bundle hash - adding a new style key across process restart produces a new bundle filename",
  async fn() {
    await cleanupTestDirs();
    fullReset();

    const sourceUrl = await writeFakeSource("addKey", "// v1");

    // ---- Process load 1: just foo ----
    const tools1 = new Styles(sourceUrl, {
      foo: css`
        color: red;
      `,
    });
    const bundle1 = await buildAndGetBundleFilename(tools1, "foo");

    await touchFakeSource(sourceUrl, "// v2");

    // ---- Process load 2: foo + bar added ----
    simulateProcessRestart();
    const tools2 = new Styles(sourceUrl, {
      foo: css`
        color: red;
      `,
      bar: css`
        color: blue;
      `,
    });
    const bundle2 = await buildAndGetBundleFilename(tools2, "foo");

    assertNotEquals(
      bundle2,
      bundle1,
      "Bundle filename must change when a new style key is added",
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "style bundle hash - removing a style key across process restart produces a new bundle filename",
  async fn() {
    await cleanupTestDirs();
    fullReset();

    const sourceUrl = await writeFakeSource("removeKey", "// v1");

    // ---- Process load 1: foo + bar ----
    const tools1 = new Styles(sourceUrl, {
      foo: css`
        color: red;
      `,
      bar: css`
        color: blue;
      `,
    });
    const bundle1 = await buildAndGetBundleFilename(tools1, "foo");

    await touchFakeSource(sourceUrl, "// v2");

    // ---- Process load 2: bar removed ----
    simulateProcessRestart();
    const tools2 = new Styles(sourceUrl, {
      foo: css`
        color: red;
      `,
    });
    const bundle2 = await buildAndGetBundleFilename(tools2, "foo");

    assertNotEquals(
      bundle2,
      bundle1,
      "Bundle filename must change when a style key is removed",
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "style bundle hash - swapping a style key (remove old + add new) across process restart produces a new bundle filename",
  async fn() {
    await cleanupTestDirs();
    fullReset();

    const sourceUrl = await writeFakeSource("swapKey", "// v1");

    const tools1 = new Styles(sourceUrl, {
      foo: css`
        color: red;
      `,
      bar: css`
        color: blue;
      `,
    });
    const bundle1 = await buildAndGetBundleFilename(tools1, "foo");

    await touchFakeSource(sourceUrl, "// v2");

    simulateProcessRestart();
    const tools2 = new Styles(sourceUrl, {
      foo: css`
        color: red;
      `,
      baz: css`
        color: green;
      `, // bar renamed to baz, different content
    });
    const bundle2 = await buildAndGetBundleFilename(tools2, "foo");

    assertNotEquals(
      bundle2,
      bundle1,
      "Bundle filename must change when a style key is renamed (effectively remove + add)",
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "style bundle hash - bundle filename uniquely identifies full CSS content of bundle (no collisions across many edits)",
  async fn() {
    await cleanupTestDirs();
    fullReset();

    const sourceUrl = await writeFakeSource("manyEdits", "// v1");
    const seen = new Map<string, string>();

    const variants: Array<Record<string, string>> = [
      { foo: "z-index: 1;" },
      { foo: "z-index: 2;" },
      { foo: "z-index: 3;" },
      { foo: "z-index: 1;", bar: "color: red;" },
      { foo: "z-index: 1;", bar: "color: blue;" },
      { foo: "z-index: 2;", bar: "color: red;" },
      { foo: "z-index: 1;", bar: "color: red;", baz: "padding: 4px;" },
      { foo: "z-index: 1;", baz: "padding: 4px;" },
      { foo: "z-index: 1;" }, // back to first — IS allowed to match variant[0]
    ];

    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
      await touchFakeSource(sourceUrl, `// v${i + 1}`);
      simulateProcessRestart();

      // Build styles object using css`...` tag
      const styles: Record<string, string> = {};
      for (const [k, v] of Object.entries(variant)) {
        styles[k] = v; // plain string CSS is also accepted by Styles
      }
      const tools = new Styles(sourceUrl, styles);
      const firstKey = Object.keys(variant)[0];
      const bundle = await buildAndGetBundleFilename(tools, firstKey);

      const variantKey = JSON.stringify(variant);
      const previousBundleForSameContent = [...seen.entries()].find(
        ([k]) => k === variantKey,
      )?.[1];

      // Look for collisions: any DIFFERENT content that produced the same bundle
      for (const [existingKey, existingBundle] of seen) {
        if (existingKey === variantKey) continue;
        assertNotEquals(
          existingBundle,
          bundle,
          `Hash collision: variant\n  ${variantKey}\nproduced same bundle ${bundle} as\n  ${existingKey}`,
        );
      }

      // Identical content should map to identical bundle filename
      if (previousBundleForSameContent !== undefined) {
        assertEquals(
          bundle,
          previousBundleForSameContent,
          "Identical content should produce identical bundle filenames",
        );
      }

      seen.set(variantKey, bundle);
    }

    assert(seen.size > 0);
    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
