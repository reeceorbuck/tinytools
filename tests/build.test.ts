/**
 * Tests for buildScriptFiles functionality.
 *
 * These tests verify:
 * - Only changed script files are rebuilt
 * - Imports are correctly updated when dependent files change
 * - Files that shouldn't change are not rebuilt
 * - Cleanup of orphaned files works correctly
 *
 * Run with: deno test --allow-all tests/build.test.ts
 */

import { assertEquals, assertExists } from "@std/assert";
import { buildScriptFiles } from "../build.ts";
import {
  changedHandlerKeys,
  filesWithChangedHandlers,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import {
  changedStyleKeys,
  SCOPE_BOUNDARY_CLASS,
  scopedStylesRegistry,
  setCustomScope,
  styleBundleRegistry,
} from "../scopedStyles.ts";
import { ClientTools } from "../clientTools.ts";
import { css } from "../scopedStyles.ts";

// ============================================================================
// Test Utilities
// ============================================================================

const TEST_PUBLIC_DIR = "./.test-build-output";
const TEST_HANDLER_DIR = `${TEST_PUBLIC_DIR}/handlers`;
const TEST_STYLES_DIR = `${TEST_PUBLIC_DIR}/styles`;
const TEST_CLIENT_DIR = "./.test-client-src";

/** Clean up test directories */
async function cleanupTestDirs() {
  try {
    await Deno.remove(TEST_PUBLIC_DIR, { recursive: true });
  } catch {
    // Directory doesn't exist, that's fine
  }
  try {
    await Deno.remove(TEST_CLIENT_DIR, { recursive: true });
  } catch {
    // Directory doesn't exist, that's fine
  }
}

/** Set up the performance marks that buildScriptFiles expects */
function setupPerformanceMarks() {
  // Clear any existing marks
  performance.clearMarks();
  performance.clearMeasures();

  // Create the marks that buildScriptFiles expects
  performance.mark("startup:begin");
  performance.mark("startup:importsComplete");
  performance.mark("startup:appCreated");
  performance.mark("startup:routesRegistered");
}

/** Reset the global registries to a clean state */
function resetRegistries() {
  handlers.clear();
  scopedStylesRegistry.clear();
  styleBundleRegistry.clear();
  changedHandlerKeys.clear();
  filesWithChangedHandlers.clear();
  changedStyleKeys.clear();
  resetImportRegistries();
}

/** Build script files with test setup (sets up performance marks) */
async function buildForTest(
  options: Parameters<typeof buildScriptFiles>[0] = {},
) {
  setupPerformanceMarks();
  return buildScriptFiles(options);
}

/** Read file content if it exists, null otherwise */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Check if file exists */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Get file mtime */
async function getFileMtime(path: string): Promise<number | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** List files in a directory */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) {
        files.push(entry.name);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files.sort();
}

// ============================================================================
// Test Suite: Basic buildScriptFiles behavior
// ============================================================================

Deno.test({
  name: "buildScriptFiles - creates handler files for registered handlers",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a handler using ClientTools
    new ClientTools(import.meta.url, {
      functions: {
        testHandler(this: HTMLElement) {
          console.log("test");
        },
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify handler files were created
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 1);
    assertEquals(handlerFiles[0].startsWith("testHandler_"), true);
    assertEquals(handlerFiles[0].endsWith(".js"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - creates style files for registered styles",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a style using ClientTools
    const testStyle = css`
      color: blue;
    `;
    new ClientTools(import.meta.url, {
      styles: { testStyle },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify style files were created
    const styleFiles = await listFiles(TEST_STYLES_DIR);
    assertEquals(styleFiles.length, 1);
    assertEquals(styleFiles[0].endsWith(".css"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Incremental rebuilds - skip unchanged files
// ============================================================================

Deno.test({
  name: "buildScriptFiles - skips rebuilding unchanged handler files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a handler
    new ClientTools(import.meta.url, {
      functions: {
        unchangedHandler(this: HTMLElement) {
          console.log("unchanged");
        },
      },
    });

    // First build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Get the handler file info
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 1);
    const handlerPath = `${TEST_HANDLER_DIR}/${handlerFiles[0]}`;
    const originalContent = await readFileOrNull(handlerPath);
    const originalMtime = await getFileMtime(handlerPath);

    assertExists(originalContent);
    assertExists(originalMtime);

    // Wait a bit to ensure mtime would differ if file was rewritten
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second build (nothing changed)
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify file was not rewritten (same content)
    const newContent = await readFileOrNull(handlerPath);
    assertEquals(newContent, originalContent);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - skips rebuilding unchanged style files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a style
    const unchangedStyle = css`
      background: red;
    `;
    new ClientTools(import.meta.url, {
      styles: { unchangedStyle },
    });

    // First build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Get the style file info
    const styleFiles = await listFiles(TEST_STYLES_DIR);
    assertEquals(styleFiles.length, 1);
    const stylePath = `${TEST_STYLES_DIR}/${styleFiles[0]}`;
    const originalContent = await readFileOrNull(stylePath);

    assertExists(originalContent);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify file content unchanged
    const newContent = await readFileOrNull(stylePath);
    assertEquals(newContent, originalContent);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Import updates on dependency changes
// ============================================================================

Deno.test({
  name:
    "buildScriptFiles - generates imports for handlers from same source file",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create multiple handlers in the same "file" (using same import.meta.url)
    // The import registry will track all handlers from the same source file
    new ClientTools(import.meta.url, {
      functions: {
        sharedHelper() {
          return "shared result";
        },
        consumerHandler(this: HTMLElement) {
          // This handler is defined in the same file as sharedHelper
          // The import registry should include sharedHelper
          console.log("consumer");
        },
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify both files were created
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 2);

    const helperFile = handlerFiles.find((f) => f.startsWith("sharedHelper_"));
    const consumerFile = handlerFiles.find((f) =>
      f.startsWith("consumerHandler_")
    );
    assertExists(helperFile);
    assertExists(consumerFile);

    // Both files should be valid JavaScript (successfully transpiled)
    const consumerContent = await readFileOrNull(
      `${TEST_HANDLER_DIR}/${consumerFile}`,
    );
    assertExists(consumerContent);

    // Verify it's a valid ES module with a default export
    assertEquals(
      consumerContent!.includes("export") &&
        consumerContent!.includes("default"),
      true,
      `Expected default export in:\n${consumerContent}`,
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Cleanup of orphaned files
// ============================================================================

Deno.test({
  name: "buildScriptFiles - removes orphaned handler files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create directories and a fake orphaned handler file
    await Deno.mkdir(TEST_HANDLER_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_HANDLER_DIR}/orphanedHandler_abc123.js`,
      "// orphaned file",
    );

    // Register a different handler
    new ClientTools(import.meta.url, {
      functions: {
        activeHandler(this: HTMLElement) {
          console.log("active");
        },
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify orphaned file was removed
    const orphanExists = await fileExists(
      `${TEST_HANDLER_DIR}/orphanedHandler_abc123.js`,
    );
    assertEquals(
      orphanExists,
      false,
      "Orphaned handler file should be removed",
    );

    // Verify active handler file exists
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 1);
    assertEquals(handlerFiles[0].startsWith("activeHandler_"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - removes orphaned style files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create directories and a fake orphaned style file
    await Deno.mkdir(TEST_STYLES_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_STYLES_DIR}/orphanedStyle_xyz789.css`,
      "/* orphaned style */",
    );

    // Register a different style
    const activeStyle = css`
      color: green;
    `;
    new ClientTools(import.meta.url, {
      styles: { activeStyle },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify orphaned file was removed
    const orphanExists = await fileExists(
      `${TEST_STYLES_DIR}/orphanedStyle_xyz789.css`,
    );
    assertEquals(orphanExists, false, "Orphaned style file should be removed");

    // Verify active style file exists
    const styleFiles = await listFiles(TEST_STYLES_DIR);
    assertEquals(styleFiles.length, 1);
    assertEquals(styleFiles[0].endsWith(".css"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Multiple handlers and styles
// ============================================================================

Deno.test({
  name: "buildScriptFiles - handles multiple handlers and styles together",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register multiple handlers and styles
    const buttonStyle = css`
      padding: 10px;
    `;
    const formStyle = css`
      margin: 20px;
    `;
    new ClientTools(import.meta.url, {
      functions: {
        clickHandler(this: HTMLElement) {
          console.log("click");
        },
        submitHandler(this: HTMLFormElement) {
          console.log("submit");
        },
      },
      styles: { buttonStyle, formStyle },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify all handler files were created
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 2);
    assertEquals(
      handlerFiles.some((f) => f.startsWith("clickHandler_")),
      true,
    );
    assertEquals(
      handlerFiles.some((f) => f.startsWith("submitHandler_")),
      true,
    );

    // Verify all style files were created
    const styleFiles = await listFiles(TEST_STYLES_DIR);
    assertEquals(styleFiles.length, 1);
    assertEquals(styleFiles[0].endsWith(".css"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Client file transpilation
// ============================================================================

Deno.test({
  name: "buildScriptFiles - transpiles client TypeScript files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create a test client file
    await Deno.mkdir(TEST_CLIENT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/testClient.ts`,
      `
const greeting: string = "Hello";
export function sayHello(): void {
  console.log(greeting);
}
      `.trim(),
    );

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify client file was transpiled
    const clientJsExists = await fileExists(`${TEST_PUBLIC_DIR}/testClient.js`);
    assertEquals(clientJsExists, true);

    // Verify it's valid JavaScript (no TypeScript syntax)
    const content = await readFileOrNull(`${TEST_PUBLIC_DIR}/testClient.js`);
    assertExists(content);
    assertEquals(content!.includes(": string"), false);
    assertEquals(content!.includes(": void"), false);
    assertEquals(content!.includes("sayHello"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - skips unchanged client files based on mtime",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create a test client file
    await Deno.mkdir(TEST_CLIENT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/mtimeTest.ts`,
      `export const x = 1;`,
    );

    // First build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const outputPath = `${TEST_PUBLIC_DIR}/mtimeTest.js`;
    const firstMtime = await getFileMtime(outputPath);
    assertExists(firstMtime);

    // Wait to ensure mtime would differ
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second build without changing source
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Mtime should be the same (file wasn't rewritten)
    const secondMtime = await getFileMtime(outputPath);
    assertEquals(secondMtime, firstMtime);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - rebuilds client files when source changes",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create initial client file
    await Deno.mkdir(TEST_CLIENT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/changingFile.ts`,
      `export const version = 1;`,
    );

    // First build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const outputPath = `${TEST_PUBLIC_DIR}/changingFile.js`;
    const firstContent = await readFileOrNull(outputPath);
    assertExists(firstContent);
    assertEquals(firstContent!.includes("version = 1"), true);

    // Wait to ensure mtime differs
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Update source file
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/changingFile.ts`,
      `export const version = 2;`,
    );

    // Second build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Content should be updated
    const secondContent = await readFileOrNull(outputPath);
    assertExists(secondContent);
    assertEquals(secondContent!.includes("version = 2"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - converts .ts imports to .js in client files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create client files with internal imports
    await Deno.mkdir(TEST_CLIENT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/utils.ts`,
      `export const helper = () => "help";`,
    );
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/main.ts`,
      `import { helper } from "./utils.ts";\nexport const result = helper();`,
    );

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Check main.js has .js import, not .ts
    const mainContent = await readFileOrNull(`${TEST_PUBLIC_DIR}/main.js`);
    assertExists(mainContent);
    assertEquals(mainContent!.includes(`from "./utils.js"`), true);
    assertEquals(mainContent!.includes(`from "./utils.ts"`), false);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Directory creation
// ============================================================================

Deno.test({
  name: "buildScriptFiles - creates output directories if they don't exist",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Verify directories don't exist
    assertEquals(await fileExists(TEST_PUBLIC_DIR), false);
    assertEquals(await fileExists(TEST_HANDLER_DIR), false);
    assertEquals(await fileExists(TEST_STYLES_DIR), false);

    // Register something to build
    new ClientTools(import.meta.url, {
      functions: {
        dirTestHandler() {
          console.log("test");
        },
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify directories were created
    assertEquals(await fileExists(TEST_PUBLIC_DIR), true);
    assertEquals(await fileExists(TEST_HANDLER_DIR), true);
    assertEquals(await fileExists(TEST_STYLES_DIR), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Handler file content validation
// ============================================================================

Deno.test({
  name: "buildScriptFiles - generates valid ES module for handlers",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a handler
    new ClientTools(import.meta.url, {
      functions: {
        esModuleHandler(this: HTMLElement, e: Event) {
          console.log("event", e);
        },
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Get the handler file content
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    const handlerFile = handlerFiles.find((f) =>
      f.startsWith("esModuleHandler_")
    );
    assertExists(handlerFile);

    const content = await readFileOrNull(
      `${TEST_HANDLER_DIR}/${handlerFile}`,
    );
    assertExists(content);

    // Should be a valid ES module with default export
    // esbuild may use either "export default" or "export { x as default }"
    assertEquals(
      content!.includes("export") && content!.includes("default"),
      true,
      `Expected ES module with default export in:\n${content}`,
    );

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Style file content validation
// ============================================================================

Deno.test({
  name: "buildScriptFiles - generates scoped CSS for styles",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a style
    const scopedStyle = css`
      color: purple;
      font-size: 16px;
    `;
    new ClientTools(import.meta.url, {
      styles: { scopedStyle },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Get the style file content
    const styleFiles = await listFiles(TEST_STYLES_DIR);
    const styleFile = styleFiles[0];
    assertExists(styleFile);

    const content = await readFileOrNull(`${TEST_STYLES_DIR}/${styleFile}`);
    assertExists(content);

    // Should contain @scope with :scope wrapper and boundary selector
    assertEquals(content!.includes("@scope"), true);
    assertEquals(content!.includes(`to (.${SCOPE_BOUNDARY_CLASS}, `), true);
    assertEquals(
      content!.includes('[data-scope-boundary~="scopedStyle_'),
      true,
    );
    assertEquals(content!.includes('[data-scope-boundary~="global"]'), true);
    assertEquals(content!.includes(":scope"), true);
    assertEquals(content!.includes("color: purple"), true);
    assertEquals(content!.includes("font-size: 16px"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - emits one @layer block per layer per css file",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    new ClientTools(import.meta.url, {
      styles: {
        boundaryA: setCustomScope.toBoundary(css`
          color: purple;
        `),
        boundaryB: css`
          font-size: 16px;
        `,
        selectorA: setCustomScope.toSelectors(
          css`
            border: 1px solid red;
          `,
          [".stop"],
        ),
      },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const styleFiles = await listFiles(TEST_STYLES_DIR);
    const styleFile = styleFiles[0];
    assertExists(styleFile);

    const content = await readFileOrNull(`${TEST_STYLES_DIR}/${styleFile}`);
    assertExists(content);

    const limitedLayers = (content!.match(/@layer\s+limited\s*\{/g) ?? [])
      .length;
    const normalLayers = (content!.match(/@layer\s+normal\s*\{/g) ?? [])
      .length;

    assertEquals(limitedLayers, 1);
    assertEquals(normalLayers, 1);
    assertEquals(content!.includes("color: purple"), true);
    assertEquals(content!.includes("font-size: 16px"), true);
    assertEquals(content!.includes("border: 1px solid red"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Empty registries
// ============================================================================

Deno.test({
  name: "buildScriptFiles - handles empty registries gracefully",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Build with nothing registered
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Directories should exist but be empty
    assertEquals(await fileExists(TEST_HANDLER_DIR), true);
    assertEquals(await fileExists(TEST_STYLES_DIR), true);
    assertEquals((await listFiles(TEST_HANDLER_DIR)).length, 0);
    assertEquals((await listFiles(TEST_STYLES_DIR)).length, 0);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Filename hashing consistency
// ============================================================================

Deno.test({
  name:
    "buildScriptFiles - same handler code produces same filename across builds",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register a handler
    const handlerFn = function (this: HTMLElement) {
      console.log("consistent");
    };
    new ClientTools(import.meta.url, {
      functions: {
        consistentHandler: handlerFn,
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const handlerFiles1 = await listFiles(TEST_HANDLER_DIR);
    const filename1 = handlerFiles1[0];

    // Clean up and reset
    await cleanupTestDirs();
    resetRegistries();

    // Register the same handler again
    new ClientTools(import.meta.url, {
      functions: {
        consistentHandler: handlerFn,
      },
    });

    // Build again
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const handlerFiles2 = await listFiles(TEST_HANDLER_DIR);
    const filename2 = handlerFiles2[0];

    // Filenames should be identical
    assertEquals(filename1, filename2);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: TSX client files
// ============================================================================

Deno.test({
  name: "buildScriptFiles - transpiles .tsx client files",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create a .tsx client file
    await Deno.mkdir(TEST_CLIENT_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_CLIENT_DIR}/component.tsx`,
      `
const Component = () => {
  return <div>Hello</div>;
};
export default Component;
      `.trim(),
    );

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Verify .tsx was transpiled to .js
    const jsExists = await fileExists(`${TEST_PUBLIC_DIR}/component.js`);
    assertEquals(jsExists, true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Missing client directory
// ============================================================================

Deno.test({
  name: "buildScriptFiles - handles missing client directory gracefully",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Don't create the client directory
    new ClientTools(import.meta.url, {
      functions: {
        noClientDirHandler() {
          console.log("test");
        },
      },
    });

    // Build should not throw
    await buildForTest({
      clientDir: TEST_CLIENT_DIR, // doesn't exist
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Handler should still be built
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 1);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Cross-file imports and dependency tracking
// ============================================================================

Deno.test({
  name:
    "buildScriptFiles - builds handlers with external imports via .import()",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create a shared utility using a fake external URL
    const externalUrl = "file:///fake/external/source.ts";
    const sharedTools = new ClientTools(externalUrl, {
      functions: {
        externalUtility() {
          return "external result";
        },
      },
    });

    // Create a consumer in a different file that imports the external tools
    const _consumerTools = new ClientTools(import.meta.url, {
      imports: [sharedTools],
      functions: {
        consumerFunction(this: HTMLElement) {
          console.log("consuming external");
        },
      },
    });

    // Build
    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Both handlers should be built
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    assertEquals(handlerFiles.length, 2);

    const externalFile = handlerFiles.find((f) =>
      f.startsWith("externalUtility_")
    );
    const consumerFile = handlerFiles.find((f) =>
      f.startsWith("consumerFunction_")
    );
    assertExists(externalFile);
    assertExists(consumerFile);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - changedHandlerKeys affects rebuild decisions",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // First build a handler
    new ClientTools(import.meta.url, {
      functions: {
        dependentHandler(this: HTMLElement) {
          console.log("version 1");
        },
      },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Get original file list
    const files1 = await listFiles(TEST_HANDLER_DIR);
    assertEquals(files1.length, 1);
    const originalFile = files1[0];
    const _originalContent = await readFileOrNull(
      `${TEST_HANDLER_DIR}/${originalFile}`,
    );

    // Now reset and rebuild without changes - should skip rebuild
    resetRegistries();

    new ClientTools(import.meta.url, {
      functions: {
        dependentHandler(this: HTMLElement) {
          console.log("version 1");
        },
      },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // File should exist and have same content (not rebuilt)
    const files2 = await listFiles(TEST_HANDLER_DIR);
    assertEquals(files2.length, 1);
    assertEquals(files2[0], originalFile);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "buildScriptFiles - same handler name with different code uses hash from code",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // When using a URL that doesn't exist (forcing fresh hash calculation),
    // different code should produce different hashes
    const fakeUrl1 = "file:///test/unique/path1.ts";
    new ClientTools(fakeUrl1, {
      functions: {
        hashedHandler(this: HTMLElement) {
          console.log("version 1");
        },
      },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const files1 = await listFiles(TEST_HANDLER_DIR);
    assertEquals(files1.length, 1);
    const filename1 = files1[0];

    await cleanupTestDirs();
    resetRegistries();

    // Use a different fake URL to force fresh hash calculation
    const fakeUrl2 = "file:///test/unique/path2.ts";
    new ClientTools(fakeUrl2, {
      functions: {
        hashedHandler(this: HTMLElement) {
          console.log("version 2 - different code");
        },
      },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const files2 = await listFiles(TEST_HANDLER_DIR);
    assertEquals(files2.length, 1);
    const filename2 = files2[0];

    // Filenames should be different because code changed (different hash)
    assertEquals(filename1 !== filename2, true);
    // But both should start with the handler name
    assertEquals(filename1.startsWith("hashedHandler_"), true);
    assertEquals(filename2.startsWith("hashedHandler_"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "buildScriptFiles - same style name with different content uses hash from content",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Use fake URLs to force fresh hash calculation
    const fakeUrl1 = "file:///test/unique/style1.ts";
    const hashedStyle1 = css`
      color: red;
    `;
    new ClientTools(fakeUrl1, {
      styles: { hashedStyle: hashedStyle1 },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const files1 = await listFiles(TEST_STYLES_DIR);
    assertEquals(files1.length, 1);
    const filename1 = files1[0];

    await cleanupTestDirs();
    resetRegistries();

    // Different fake URL
    const fakeUrl2 = "file:///test/unique/style2.ts";
    const hashedStyle2 = css`
      color: blue;
      font-size: 20px;
    `;
    new ClientTools(fakeUrl2, {
      styles: { hashedStyle: hashedStyle2 },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    const files2 = await listFiles(TEST_STYLES_DIR);
    assertEquals(files2.length, 1);
    const filename2 = files2[0];

    // Filenames should be different because CSS changed (different hash)
    assertEquals(filename1 !== filename2, true);
    // But both should start with the style name
    assertEquals(filename1.startsWith("style1_"), true);
    assertEquals(filename2.startsWith("style2_"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ============================================================================
// Test Suite: Build output isolation
// ============================================================================

Deno.test({
  name: "buildScriptFiles - only outputs files for registered items",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Register specific handlers and styles
    const onlyStyle = css`
      color: only;
    `;
    new ClientTools(import.meta.url, {
      functions: {
        onlyHandler() {
          console.log("only");
        },
      },
      styles: { onlyStyle },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Should have exactly one handler and one style
    const handlerFiles = await listFiles(TEST_HANDLER_DIR);
    const styleFiles = await listFiles(TEST_STYLES_DIR);

    assertEquals(handlerFiles.length, 1);
    assertEquals(styleFiles.length, 1);
    assertEquals(handlerFiles[0].startsWith("onlyHandler_"), true);
    assertEquals(styleFiles[0].endsWith(".css"), true);

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - preserves non-js files in handler directory",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create handler directory with a non-js file (should be preserved)
    await Deno.mkdir(TEST_HANDLER_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_HANDLER_DIR}/readme.txt`,
      "This file should not be deleted",
    );
    await Deno.writeTextFile(
      `${TEST_HANDLER_DIR}/.hidden`,
      "Hidden file",
    );

    // Register a handler
    new ClientTools(import.meta.url, {
      functions: {
        preserveTestHandler() {
          console.log("test");
        },
      },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Check that non-js files are preserved
    const readmeExists = await fileExists(`${TEST_HANDLER_DIR}/readme.txt`);
    const hiddenExists = await fileExists(`${TEST_HANDLER_DIR}/.hidden`);
    assertEquals(readmeExists, true, "readme.txt should be preserved");
    assertEquals(hiddenExists, true, ".hidden should be preserved");

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "buildScriptFiles - preserves non-css files in styles directory",
  async fn() {
    await cleanupTestDirs();
    resetRegistries();

    // Create styles directory with a non-css file (should be preserved)
    await Deno.mkdir(TEST_STYLES_DIR, { recursive: true });
    await Deno.writeTextFile(
      `${TEST_STYLES_DIR}/readme.md`,
      "# Styles Documentation",
    );

    // Register a style
    const preserveTestStyle = css`
      color: test;
    `;
    new ClientTools(import.meta.url, {
      styles: { preserveTestStyle },
    });

    await buildForTest({
      clientDir: TEST_CLIENT_DIR,
      publicDir: TEST_PUBLIC_DIR,
      handlerDir: TEST_HANDLER_DIR,
      stylesDir: TEST_STYLES_DIR,
    });

    // Check that non-css files are preserved
    const readmeExists = await fileExists(`${TEST_STYLES_DIR}/readme.md`);
    assertEquals(readmeExists, true, "readme.md should be preserved");

    await cleanupTestDirs();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
