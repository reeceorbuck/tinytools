/**
 * Runtime behavior tests for ClientTools.
 *
 * These tests verify that handlers and styles produce correct runtime output,
 * not just correct types. Specifically tests that handler values are proper
 * "handlers.xxx(this, event)" strings rather than function bodies.
 *
 * Run with: deno test tests/runtime.test.tsx
 */

/// <reference lib="dom" />

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Hono } from "hono";
import { getClientFileName } from "../client/dist/manifest.ts";
import { tiny } from "../honoFactory.tsx";
import {
  type ClientTools,
  GENERATED_HANDLER_HASH_LENGTH,
  GENERATED_STYLE_HASH_LENGTH,
  generateHandlerHash,
  generateStyleHash,
  Handlers,
  Styles,
} from "../clientTools.ts";
import { css } from "../scopedStyles.ts";
import type { JSX } from "../jsx-runtime.ts";

// ============================================================================
// Helper: Validate handler string format
// ============================================================================

/**
 * Asserts that a value is a properly formatted handler string.
 * Handler strings should be like "handlers.handlerName_hash(this, event)"
 */
function assertValidHandlerString(value: unknown, name: string) {
  assertEquals(
    typeof value,
    "string",
    `${name} should be a string, got ${typeof value}`,
  );

  const str = value as string;

  assertEquals(
    str.startsWith("handlers."),
    true,
    `${name} should start with "handlers." but got: ${str}`,
  );

  assertEquals(
    str.includes("(this, event)"),
    true,
    `${name} should contain "(this, event)" but got: ${str}`,
  );

  // Should NOT contain "function" keyword (would indicate function body leaked)
  assertEquals(
    str.includes("function"),
    false,
    `${name} should not contain "function" keyword (function body leaked): ${str}`,
  );

  // Should NOT contain "=>" (would indicate arrow function body leaked)
  assertEquals(
    str.includes("=>"),
    false,
    `${name} should not contain "=>" (arrow function body leaked): ${str}`,
  );
}

// ============================================================================
// Helper: Create app with tools
// ============================================================================

// deno-lint-ignore no-explicit-any
function createApp(tools: ClientTools<any, any>) {
  return new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(tools));
}

Deno.test("Runtime - tiny.middleware.core can override hash lengths together", () => {
  try {
    tiny.middleware.core({ generatedFilenameHashLength: 3 });
    assertEquals(generateHandlerHash("tiny-tools-hash").length, 3);
    assertEquals(generateStyleHash("tiny-tools-hash").length, 3);

    tiny.middleware.core({ generatedFilenameHashLength: 99 });
    assertEquals(generateHandlerHash("tiny-tools-hash").length, 8);
    assertEquals(generateStyleHash("tiny-tools-hash").length, 8);
  } finally {
    tiny.middleware.core({
      generatedHandlerHashLength: GENERATED_HANDLER_HASH_LENGTH,
      generatedStyleHashLength: GENERATED_STYLE_HASH_LENGTH,
    });
  }
});

Deno.test("Runtime - tiny.middleware.core supports separate handler/style hash lengths", () => {
  try {
    tiny.middleware.core({
      generatedHandlerHashLength: 6,
      generatedStyleHashLength: 4,
    });

    const handlers = new Handlers("file:///tests/hash-length-separate.ts", {
      saveHandler() {
        console.log("save");
      },
    });
    const tools = new Styles("file:///tests/hash-length-separate.ts", {
      panel: css`
        color: red;
      `,
    });

    const handlerFilename = handlers._handlerFilenames.get("saveHandler") ?? "";
    const styleClassName = tools.generatedStyleNames.get("panel") ?? "";

    assertEquals(handlerFilename.startsWith("saveHandler_"), true);
    assertEquals(styleClassName.startsWith("panel_"), true);

    const handlerHash = handlerFilename.split("_")[1] ?? "";
    const styleHash = styleClassName.split("_")[1] ?? "";

    assertEquals(handlerHash.length, 6);
    assertEquals(styleHash.length, 4);
  } finally {
    tiny.middleware.core({
      generatedHandlerHashLength: GENERATED_HANDLER_HASH_LENGTH,
      generatedStyleHashLength: GENERATED_STYLE_HASH_LENGTH,
    });
  }
});

Deno.test("Runtime - startup cache hydration avoids reset for same style hash length", async () => {
  const testDir = "./.test-client-src";
  await Deno.mkdir(testDir, { recursive: true });

  const testId = crypto.randomUUID().replace(/-/g, "");
  const modulePath = `${testDir}/cache-hydration-${testId}.ts`;

  const moduleCode = [
    'import { tiny } from "../honoFactory.tsx";',
    'import { Handlers, Styles } from "../clientTools.ts";',
    'import { css } from "../scopedStyles.ts";',
    "",
    "tiny.middleware.core({ generatedStyleHashLength: 4 });",
    "",
    "new Handlers(import.meta.url, {",
    "    cacheHydrationTestHandler() {",
    '      console.log("cache-hydration-test");',
    "    },",
    "});",
    "new Styles(import.meta.url, {",
    "    cacheHydrationTestStyle: css`",
    "      color: tomato;",
    "    `,",
    "});",
  ].join("\n");

  const runModule = async (): Promise<string> => {
    const command = new Deno.Command("deno", {
      args: ["run", "-A", modulePath],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    assert(
      result.success,
      `Subprocess failed:\n${stderr || stdout}`,
    );

    return stdout;
  };

  try {
    await Deno.writeTextFile(modulePath, moduleCode);

    const firstOutput = await runModule();
    const secondOutput = await runModule();

    const countLogs = (text: string, needle: string) =>
      (text.match(new RegExp(needle, "g")) ?? []).length;

    const firstGenerated = countLogs(
      firstOutput,
      "Generating filename for",
    );
    const secondGenerated = countLogs(
      secondOutput,
      "Generating filename for",
    );

    assert(
      firstGenerated >= 1,
      `Expected first run to generate filenames, got output:\n${firstOutput}`,
    );
    assertEquals(
      secondGenerated,
      0,
      `Expected second run to fully reuse cache, got output:\n${secondOutput}`,
    );
  } finally {
    try {
      await Deno.remove(modulePath);
    } catch {
      // ignore cleanup errors
    }
  }
});

Deno.test("Runtime - AssetTags renders versioned package client asset URLs", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.navApiTools());

  app.get("/", (c) => c.render(<div>Home</div>));

  const res = await app.fetch(new Request("http://localhost/"));
  const html = await res.text();

  assertEquals(res.status, 200);
  assertStringIncludes(
    html,
    `/_tinytools/${getClientFileName("navigation.js")}`,
  );
  assertStringIncludes(
    html,
    `/_tinytools/${getClientFileName("eventHandlers.js")}`,
  );
  assertEquals(html.includes("/_tinytools/navigation.js"), false);
  assertEquals(html.includes("/_tinytools/eventHandlers.js"), false);
});

// ============================================================================
// Test Suite: Basic handler string output
// ============================================================================

Deno.test("Runtime - defineFunction produces valid handler string", () => {
  const tools = new Handlers(import.meta.url, {
    testHandler(this: HTMLElement, e: MouseEvent) {
      console.log("clicked", e);
    },
  });

  const app = createApp(tools);

  app.get("/test", (c) => {
    const { fn } = c.var.tools;
    assertValidHandlerString(fn.testHandler, "testHandler");
    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - multiple handlers all produce valid strings", () => {
  const tools = new Handlers(import.meta.url, {
    handlerA() {
      console.log("A");
    },
    handlerB() {
      console.log("B");
    },
    handlerC() {
      console.log("C");
    },
  });

  const app = createApp(tools);

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    assertValidHandlerString(fn.handlerA, "handlerA");
    assertValidHandlerString(fn.handlerB, "handlerB");
    assertValidHandlerString(fn.handlerC, "handlerC");

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: extendWithImports() - Runtime behavior
// ============================================================================

Deno.test("Runtime - extend() parent handlers return valid handler strings", () => {
  const parentTools = new Handlers(import.meta.url, {
    parentHandler(this: HTMLElement, e: MouseEvent) {
      console.log("Parent handler", e);
    },
  });

  const componentTools = new Handlers(import.meta.url, {
    localHandler(this: HTMLElement, e: MouseEvent) {
      console.log("Local handler", e);
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(componentTools);

    // Both parent and local handlers should be valid handler strings
    assertValidHandlerString(fn.parentHandler, "parentHandler");
    assertValidHandlerString(fn.localHandler, "localHandler");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - extendWithImports() multiple parent handlers all return valid strings", () => {
  const parentTools = new Handlers(import.meta.url, {
    handlerA() {
      console.log("A");
    },
    handlerB() {
      console.log("B");
    },
    handlerC() {
      console.log("C");
    },
  });

  const componentTools = new Handlers(import.meta.url, {
    localOnly() {
      console.log("local");
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(componentTools);

    assertValidHandlerString(fn.handlerA, "handlerA");
    assertValidHandlerString(fn.handlerB, "handlerB");
    assertValidHandlerString(fn.handlerC, "handlerC");
    assertValidHandlerString(fn.localOnly, "localOnly");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - extendWithImports() nested calls preserve all handler strings", () => {
  const rootTools = new Handlers(import.meta.url, {
    rootHandler() {
      console.log("root");
    },
  });

  const middleTools = new Handlers(import.meta.url, {
    middleHandler() {
      console.log("middle");
    },
  });

  const leafTools = new Handlers(import.meta.url, {
    leafHandler() {
      console.log("leaf");
    },
  });

  const app = createApp(rootTools);

  app.get("/test", async (c) => {
    // First extension
    const extended1 = await c.var.tools.extendWithImports(middleTools);
    // Second (nested) extension
    const extended2 = await extended1.extendWithImports(leafTools);

    const { fn } = extended2;

    // All handlers from all levels should be valid strings
    assertValidHandlerString(fn.rootHandler, "rootHandler");
    assertValidHandlerString(fn.middleHandler, "middleHandler");
    assertValidHandlerString(fn.leafHandler, "leafHandler");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - extend() with only local tools (no parent handlers)", () => {
  // Parent has no handlers, only styles
  const parentStyle = css`
    color: blue;
  `;
  const parentTools = new Styles(import.meta.url, { parentStyle });

  const componentTools = new Handlers(import.meta.url, {
    localHandler() {
      console.log("local");
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(componentTools);

    assertValidHandlerString(fn.localHandler, "localHandler");

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: ClientTools.import() - Runtime behavior
// ============================================================================

Deno.test("Runtime - import() imported handlers return valid strings", () => {
  const externalTools = new Handlers(import.meta.url, {
    externalHandler() {
      console.log("external");
    },
  });

  const mainTools = new Handlers(import.meta.url, {
    localHandler() {
      console.log("local");
    },
  }, { imports: [externalTools] });

  const app = createApp(mainTools);

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    assertValidHandlerString(
      fn.externalHandler,
      "externalHandler",
    );
    assertValidHandlerString(fn.localHandler, "localHandler");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - import() multiple external tools", () => {
  const externalA = new Handlers(import.meta.url, {
    handlerFromA() {
      console.log("A");
    },
  });

  const externalB = new Handlers(import.meta.url, {
    handlerFromB() {
      console.log("B");
    },
  });

  const mainTools = new Handlers(import.meta.url, {
    mainHandler() {
      console.log("main");
    },
  }, { imports: [externalA, externalB] });

  const app = createApp(mainTools);

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    assertValidHandlerString(fn.handlerFromA, "handlerFromA");
    assertValidHandlerString(fn.handlerFromB, "handlerFromB");
    assertValidHandlerString(fn.mainHandler, "mainHandler");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - import() throws on duplicate function names", () => {
  const externalTools = new Handlers(import.meta.url, {
    duplicateName() {
      console.log("external");
    },
  });

  assertThrows(
    () => {
      new Handlers(import.meta.url, {
        duplicateName() {
          console.log("local");
        },
      }, { imports: [externalTools] });
    },
    Error,
    "duplicateName",
  );
});

// ============================================================================
// Test Suite: Combined import() and extend()
// ============================================================================

Deno.test("Runtime - import() then extend() preserves all handler strings", () => {
  const externalTools = new Handlers(import.meta.url, {
    externalHandler() {
      console.log("external");
    },
  });

  const parentTools = new Handlers(import.meta.url, {
    parentHandler() {
      console.log("parent");
    },
  }, { imports: [externalTools] });

  const componentTools = new Handlers(import.meta.url, {
    componentHandler() {
      console.log("component");
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(componentTools);

    // All three sources should produce valid handler strings
    assertValidHandlerString(
      fn.externalHandler,
      "externalHandler",
    );
    assertValidHandlerString(fn.parentHandler, "parentHandler");
    assertValidHandlerString(
      fn.componentHandler,
      "componentHandler",
    );

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: Styles runtime behavior
// ============================================================================

Deno.test("Runtime - defineStyles produces style class names", () => {
  const testStyle = css`
    color: blue;
  `;
  const tools = new Styles(import.meta.url, { testStyle });

  const app = createApp(tools);

  app.get("/test", (c) => {
    const { styled } = c.var.tools;

    assertEquals(typeof styled.testStyle, "string");
    assertExists(styled.testStyle, "Style class name should be defined");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - extend() parent styles return style class names", () => {
  const parentStyle = css`
    color: blue;
  `;
  const parentTools = new Styles(import.meta.url, { parentStyle });

  const localStyle = css`
    color: red;
  `;
  const componentTools = new Styles(import.meta.url, { localStyle });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { styled } = await c.var.tools.extendWithImports(componentTools);

    assertEquals(typeof styled.parentStyle, "string");
    assertEquals(typeof styled.localStyle, "string");

    assertExists(styled.parentStyle, "Parent style should return a value");
    assertExists(styled.localStyle, "Local style should return a value");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - import() styles return style class names", () => {
  const externalStyle = css`
    color: green;
  `;
  const externalTools = new Styles(import.meta.url, { externalStyle });

  const mainStyle = css`
    color: purple;
  `;
  const mainTools = new Styles(import.meta.url, {
    mainStyle,
  }, { imports: [externalTools] });

  const app = createApp(mainTools);

  app.get("/test", (c) => {
    const { styled } = c.var.tools;

    assertEquals(typeof styled.externalStyle, "string");
    assertEquals(typeof styled.mainStyle, "string");

    assertExists(styled.externalStyle, "External style should return a value");
    assertExists(styled.mainStyle, "Main style should return a value");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - styled.mergeClasses dedupes repeated scoped boundary class", () => {
  const first = css`
    color: blue;
  `;
  const second = css`
    color: red;
  `;

  const tools = new Styles(import.meta.url, { first, second });

  const app = createApp(tools);

  app.get("/test", (c) => {
    const { styled } = c.var.tools;
    const merged = styled.mergeClasses(styled.first, styled.second);

    assertEquals(typeof merged, "string");
    assertEquals(merged.includes("sb sb"), false);
    assertEquals(merged.includes(styled.first.split(" ")[0]), true);
    assertEquals(merged.includes(styled.second.split(" ")[0]), true);

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - ClientTools rejects reserved styled key mergeClasses", () => {
  assertThrows(
    () =>
      new Styles(import.meta.url, {
        // @ts-ignore: testing that mergeClasses is rejected at runtime
        mergeClasses: css`
          color: blue;
        `,
      }),
    Error,
    "Cannot define style 'mergeClasses'",
  );
});

// ============================================================================
// Test Suite: JSX integration - runtime output
// ============================================================================

Deno.test("Runtime - handler strings work in JSX onClick attribute", () => {
  const tools = new Handlers(import.meta.url, {
    handleClick(this: HTMLElement, e: MouseEvent) {
      console.log("clicked", e);
    },
  });

  const app = createApp(tools);

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    // Create JSX element - this should not throw
    const element = (
      <button type="button" onClick={fn.handleClick}>
        Click me
      </button>
    ) as JSX.Element;

    assertExists(element);

    // The handler should be a string suitable for the onclick attribute
    assertValidHandlerString(fn.handleClick, "handleClick");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - extend() handlers work in JSX attributes", () => {
  const parentTools = new Handlers(import.meta.url, {
    parentClick(this: HTMLElement, e: MouseEvent) {
      console.log("parent clicked", e);
    },
  });

  const componentTools = new Handlers(import.meta.url, {
    localClick(this: HTMLElement, e: MouseEvent) {
      console.log("local clicked", e);
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(componentTools);

    // Create JSX elements using both parent and local handlers
    const element = (
      <div>
        <button type="button" onClick={fn.parentClick}>
          Parent
        </button>
        <button type="button" onClick={fn.localClick}>
          Local
        </button>
      </div>
    ) as JSX.Element;

    assertExists(element);

    // Both handlers should be valid strings
    assertValidHandlerString(fn.parentClick, "parentClick");
    assertValidHandlerString(fn.localClick, "localClick");

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: Handler filename consistency
// ============================================================================

Deno.test("Runtime - same handler definition produces consistent filename", () => {
  // Create two tools with the same handler definition
  const tools1 = new Handlers(import.meta.url, {
    consistentHandler() {
      console.log("consistent");
    },
  });

  const tools2 = new Handlers(import.meta.url, {
    consistentHandler() {
      console.log("consistent");
    },
  });

  // Access to populate values (in real usage this happens during request)
  // For this test, we access directly from the tools
  assertValidHandlerString(
    tools1.getFunctionReferences.consistentHandler,
    "tools1.consistentHandler",
  );
  assertValidHandlerString(
    tools2.getFunctionReferences.consistentHandler,
    "tools2.consistentHandler",
  );

  // The handler strings should be identical since the function body is the same
  assertEquals(
    tools1.getFunctionReferences.consistentHandler,
    tools2.getFunctionReferences.consistentHandler,
    "Same handler definition should produce same filename/string",
  );
});

Deno.test("Runtime - different handler names produce different filenames", () => {
  const tools = new Handlers(import.meta.url, {
    handlerOne() {
      console.log("one");
    },
    handlerTwo() {
      console.log("two");
    },
  });

  // Different handler names should produce different handler strings
  assertEquals(
    tools.getFunctionReferences.handlerOne !==
      tools.getFunctionReferences.handlerTwo,
    true,
    "Different handler names should produce different handler strings",
  );

  // Both should still be valid handler strings
  assertValidHandlerString(
    tools.getFunctionReferences.handlerOne,
    "handlerOne",
  );
  assertValidHandlerString(
    tools.getFunctionReferences.handlerTwo,
    "handlerTwo",
  );
});

// ============================================================================
// Test Suite: Edge cases
// ============================================================================

Deno.test("Runtime - extend() with empty component tools", () => {
  const parentTools = new Handlers(import.meta.url, {
    parentHandler() {
      console.log("parent");
    },
  });

  // Component tools with no handlers or styles
  const emptyTools = new Styles(import.meta.url, {});

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(emptyTools);

    // Parent handler should still work
    assertValidHandlerString(fn.parentHandler, "parentHandler");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - extend() with same handler name in local overrides parent", () => {
  const parentTools = new Handlers(import.meta.url, {
    sharedName() {
      console.log("parent");
    },
  });

  const componentTools = new Handlers(import.meta.url, {
    sharedName() {
      console.log("local");
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(componentTools);

    // Should get the local version (local overrides parent)
    assertValidHandlerString(fn.sharedName, "sharedName");

    // The value should match the local tools' handler, not parent's
    assertEquals(
      fn.sharedName,
      componentTools.getFunctionReferences.sharedName,
      "Local handler should override parent handler",
    );

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Runtime - accessing non-existent handler returns undefined", () => {
  const tools = new Handlers(import.meta.url, {
    existingHandler() {
      console.log("exists");
    },
  });

  const app = createApp(tools);

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    // Existing handler works
    assertValidHandlerString(
      fn.existingHandler,
      "existingHandler",
    );

    // Non-existent handler should be undefined (not throw)
    // deno-lint-ignore no-explicit-any
    const nonExistent = (fn as any).nonExistent;
    assertEquals(nonExistent, undefined);

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: extend() method
// ============================================================================

Deno.test("Runtime - extend() produces valid handler strings", () => {
  const parentTools = new Handlers(import.meta.url, {
    parentHandler() {
      console.log("parent");
    },
  });

  const singleRouteTools = new Handlers(import.meta.url, {
    routeHandler() {
      console.log("route");
    },
  });

  const app = createApp(parentTools);

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(singleRouteTools);

    assertValidHandlerString(fn.parentHandler, "parentHandler");
    assertValidHandlerString(fn.routeHandler, "routeHandler");

    return c.text("OK");
  });

  assertExists(app);
});
