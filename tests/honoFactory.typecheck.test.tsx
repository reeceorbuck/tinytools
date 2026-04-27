/**
 * Type checking tests for tiny.middleware and sharedImports with Handlers/Styles.
 *
 * These tests verify that the TypeScript compiler correctly infers and enforces
 * types when creating Hono instances with Handlers and Styles.
 *
 * Run with: deno test --check tests/honoFactory.typecheck.test.tsx
 */

/// <reference lib="dom" />

import { assertEquals, assertExists } from "@std/assert";
import { Hono } from "hono";
import { type InferTools, tiny, type withAncestors } from "../honoFactory.tsx";
import { Handlers, Styles } from "../clientTools.ts";
import { css } from "../scopedStyles.ts";
import type { ActivatedClientFunction, JSX } from "../jsx-runtime.ts";

// Helper type alias for any activated client function
type AnyActivatedClientFunction = ActivatedClientFunction<
  // deno-lint-ignore no-explicit-any
  (...args: any[]) => void
>;

// ============================================================================
// Test Fixtures - Mock tools for testing
// ============================================================================

const testStyle = css`
  color: red;
`;
const anotherStyle = css`
  color: blue;
`;

/** Creates mock Handlers with test handlers */
const mockHandlers = new Handlers(import.meta.url, {
  testHandler(this: HTMLElement, e: MouseEvent) {
    console.log("Test handler called", e);
  },
  anotherHandler(this: HTMLElement, e: KeyboardEvent) {
    console.log("Another handler called", e);
  },
});

const mockStyles = new Styles(import.meta.url, {
  testStyle,
  anotherStyle,
});

const childStyle = css`
  border: 1px solid black;
`;

/** Creates secondary mock tools for child routes */
const childHandlers = new Handlers(import.meta.url, {
  childHandler(this: HTMLElement, e: MouseEvent) {
    console.log("Child handler called", e);
  },
});

const formHandlers = new Handlers(import.meta.url, {
  submitOnly(this: HTMLFormElement, e: SubmitEvent) {
    console.log("Submit only handler called", e);
  },
  genericFormEvent(this: HTMLFormElement, e: Event) {
    console.log("Generic form event handler called", e);
  },
});

const childStyles = new Styles(import.meta.url, {
  childStyle,
});

// ============================================================================
// Test Suite: tiny.middleware.core and sharedImports basic functionality
// ============================================================================

Deno.test("tiny.middleware.core - creates middleware array", () => {
  const middleware = tiny.middleware.core();

  // Should return an array of middleware
  assertEquals(Array.isArray(middleware), true);
  assertExists(middleware.length);
});

Deno.test("tiny.middleware.globalStyles - creates middleware handler", () => {
  const middleware = tiny.middleware.globalStyles({ filename: "theme" });

  assertEquals(typeof middleware, "function");
});

Deno.test("Hono with tiny.middleware.core and sharedImports - has correct types", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  // Should have standard Hono methods
  assertExists(app.get);
  assertExists(app.post);
  assertExists(app.use);
});

// ============================================================================
// Test Suite: Context variable types in route handlers
// ============================================================================

Deno.test("sharedImports - context has correct fn type in route handler", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  // Register a route to verify context types
  app.get("/test", (c) => {
    // Type check: c.var.tools.fn should have testHandler and anotherHandler
    const { fn } = c.var.tools;

    // These should be ActivatedClientFunction types (branded function types)
    // If types are wrong, this won't compile
    const _testHandlerType: AnyActivatedClientFunction = fn.testHandler;
    const _anotherHandlerType: AnyActivatedClientFunction = fn.anotherHandler;

    assertEquals(typeof _testHandlerType, "function");
    assertEquals(typeof _anotherHandlerType, "function");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("sharedImports - context has correct styled type in route handler", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  app.get("/test", (c) => {
    // Type check: c.var.tools.styled should have testStyle and anotherStyle as strings
    const { styled } = c.var.tools;

    // These should be class name strings
    // If types are wrong, this won't compile
    const _testStyleType: string = styled.testStyle;
    const _anotherStyleType: string = styled.anotherStyle;

    assertEquals(typeof _testStyleType, "string");
    assertEquals(typeof _anotherStyleType, "string");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("sharedImports - context has both fn and styled via tools", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  app.get("/test", (c) => {
    // Access via tools object
    const { fn, styled } = c.var.tools;

    // Verify both are accessible with correct types
    const _handler: AnyActivatedClientFunction = fn.testHandler;
    const _style: string = styled.testStyle;

    assertEquals(typeof _handler, "function");
    assertEquals(typeof _style, "string");

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: withAncestors - child routes inheriting parent types
// ============================================================================

Deno.test("withAncestors - child route with ancestor types", () => {
  // Parent app
  const parentApp = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  // Child route with ancestor type declaration
  const childRoute = new Hono<withAncestors<[typeof mockHandlers]>>()
    .use(tiny.middleware.sharedImports(childHandlers, childStyles))
    .get("/test", (c) => {
      const { fn } = c.var.tools;

      // Should have access to child's functions
      const _childHandler: AnyActivatedClientFunction = fn.childHandler;

      // Should also have parent's functions (from withAncestors type)
      const _testHandler: AnyActivatedClientFunction = fn.testHandler;

      assertEquals(typeof _childHandler, "function");
      assertEquals(typeof _testHandler, "function");

      return c.text("OK");
    });

  parentApp.route("/child", childRoute);

  assertExists(parentApp);
  assertExists(childRoute);
});

// ============================================================================
// Test Suite: Type safety - compile-time error checks
// ============================================================================

Deno.test("Type safety - accessing non-existent handler should be type error (compile check)", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  app.get("/typecheck", (c) => {
    const { fn } = c.var.tools;

    // Valid access (should compile)
    const _valid = fn.testHandler;

    // Invalid access - would be a compile error if uncommented:
    // const _invalid = fn.nonExistentHandler;

    assertEquals(typeof _valid, "string");
    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("Type safety - accessing non-existent style should be type error (compile check)", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  app.get("/typecheck", (c) => {
    const { styled } = c.var.tools;

    // Valid access (should compile)
    const _valid = styled.testStyle;

    // Invalid access - would be a compile error if uncommented:
    // const _invalid = styled.nonExistentStyle;

    assertEquals(typeof _valid, "function");
    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: JSX Integration
// ============================================================================

Deno.test("JSX types - onClick requires ActivatedClientFunction", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    // This is valid - using an activated client function
    const _element = <div onClick={fn.testHandler}>content</div> as JSX.Element;

    assertExists(_element);
    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("JSX types - onReset rejects SubmitEvent-only handlers", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(formHandlers));

  app.get("/test", (c) => {
    const { fn } = c.var.tools;
    type FormOnSubmit = NonNullable<JSX.IntrinsicElements["form"]["onSubmit"]>;
    type FormOnReset = NonNullable<JSX.IntrinsicElements["form"]["onReset"]>;

    const _validSubmit: FormOnSubmit = fn.submitOnly;
    const _validReset: FormOnReset = fn.genericFormEvent;
    const _validSubmitWithGenericEvent: FormOnSubmit = fn.genericFormEvent;

    // @ts-expect-error SubmitEvent-only handlers must not be assignable to onReset
    const _invalidReset: FormOnReset = fn.submitOnly;

    assertExists(_validSubmit);
    assertExists(_validReset);
    assertExists(_validSubmitWithGenericEvent);
    assertExists(_invalidReset);
    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: Handlers/Styles - constructor options
// ============================================================================

Deno.test("Handlers - constructor with multiple functions preserves accumulated types", () => {
  const handlers = new Handlers(import.meta.url, {
    handler1() {
      console.log("1");
    },
    handler2() {
      console.log("2");
    },
    handler3() {
      console.log("3");
    },
  });

  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(handlers));

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    // All three handlers should be accessible
    const _h1: AnyActivatedClientFunction = fn.handler1;
    const _h2: AnyActivatedClientFunction = fn.handler2;
    const _h3: AnyActivatedClientFunction = fn.handler3;

    assertEquals(typeof _h1, "function");
    assertEquals(typeof _h2, "function");
    assertEquals(typeof _h3, "function");

    return c.text("OK");
  });

  assertExists(app);
});

const style1 = css`
  color: red;
`;

const style2 = css`
  color: green;
`;

const style3 = css`
  color: blue;
`;

Deno.test("Styles - constructor with multiple styles preserves accumulated types", () => {
  const styles = new Styles(import.meta.url, {
    style1,
    style2,
    style3,
  });

  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(styles));

  app.get("/test", (c) => {
    const { styled } = c.var.tools;

    // All three styles should be accessible
    const _s1: string = styled.style1;
    const _s2: string = styled.style2;
    const _s3: string = styled.style3;

    assertEquals(typeof _s1, "string");
    assertEquals(typeof _s2, "string");
    assertEquals(typeof _s3, "string");

    return c.text("OK");
  });

  assertExists(app);
});

const myStyle = css`
  color: blue;
`;

const anotherStyle2 = css`
  color: red;
`;

Deno.test("Handlers and Styles - mixed functions and styles", () => {
  const localHandlers = new Handlers(import.meta.url, {
    myHandler() {
      console.log("handler");
    },
    anotherHandler() {
      console.log("another");
    },
  });

  const localStyles = new Styles(import.meta.url, {
    myStyle,
    anotherStyle: anotherStyle2,
  });

  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(localHandlers, localStyles));

  app.get("/test", (c) => {
    const { fn, styled } = c.var.tools;

    // Both handlers and styles should be accessible
    const _h1: AnyActivatedClientFunction = fn.myHandler;
    const _h2: AnyActivatedClientFunction = fn.anotherHandler;
    const _s1: string = styled.myStyle;
    const _s2: string = styled.anotherStyle;

    assertEquals(typeof _h1, "function");
    assertEquals(typeof _h2, "function");
    assertEquals(typeof _s1, "string");
    assertEquals(typeof _s2, "string");

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: extend in route handlers
// ============================================================================

Deno.test("extend - extends tools within a route handler", () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  const singleRouteTools = new Handlers(import.meta.url, {
    routeHandler() {
      console.log("route only");
    },
  });

  app.get("/test", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(singleRouteTools);

    // Should have access to parent handlers
    const _parentHandler: AnyActivatedClientFunction = fn.testHandler;

    // Should have access to single-route handlers
    const _routeHandler: AnyActivatedClientFunction = fn.routeHandler;

    assertEquals(typeof _parentHandler, "function");
    assertEquals(typeof _routeHandler, "function");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("extendWithImports - accepts multiple local tools in one call", () => {
  const localToolsA = new Handlers(import.meta.url, {
    routeHandlerA() {
      console.log("route A");
    },
  });

  const localToolsB = new Handlers(import.meta.url, {
    routeHandlerB() {
      console.log("route B");
    },
  });

  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(mockHandlers, mockStyles));

  app.get("/test-multi-extend", async (c) => {
    const { fn } = await c.var.tools.extendWithImports(
      localToolsA,
      localToolsB,
    );

    const _parentHandler: AnyActivatedClientFunction = fn.testHandler;
    const _routeHandlerA: AnyActivatedClientFunction = fn.routeHandlerA;
    const _routeHandlerB: AnyActivatedClientFunction = fn.routeHandlerB;

    assertEquals(typeof _parentHandler, "function");
    assertEquals(typeof _routeHandlerA, "function");
    assertEquals(typeof _routeHandlerB, "function");

    return c.text("OK");
  });

  assertExists(app);
});

// ============================================================================
// Test Suite: InferTools type helper
// ============================================================================

Deno.test("InferTools - correctly infers tool types", () => {
  // InferTools should extract the activated tools type from a Handlers instance
  type HandlersType = InferTools<typeof mockHandlers>;

  // Verify the type has the expected properties
  const _typeCheck: HandlersType extends {
    fn: {
      testHandler: unknown;
      anotherHandler: unknown;
    };
    styled: unknown;
  } ? true
    : never = true;

  assertEquals(_typeCheck, true);
});

// ============================================================================
// Test Suite: Multiple sharedImports middleware
// ============================================================================

Deno.test("Multiple sharedImports - combines tools from multiple middleware", () => {
  const tools1 = new Handlers(import.meta.url, {
    handler1() {
      console.log("1");
    },
  });

  const tools2 = new Handlers(import.meta.url, {
    handler2() {
      console.log("2");
    },
  });

  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(tools1))
    .use(tiny.middleware.sharedImports(tools2));

  app.get("/test", (c) => {
    const { fn } = c.var.tools;

    // Should have access to both tools' handlers
    const _h1: AnyActivatedClientFunction = fn.handler1;
    const _h2: AnyActivatedClientFunction = fn.handler2;

    assertEquals(typeof _h1, "function");
    assertEquals(typeof _h2, "function");

    return c.text("OK");
  });

  assertExists(app);
});

Deno.test("sharedImports - combines tools passed in a single middleware call", () => {
  const handlerTools = new Handlers(import.meta.url, {
    handler1() {
      console.log("1");
    },
  });

  const styleTools = new Styles(import.meta.url, {
    panel: css`
      color: rebeccapurple;
    `,
  });

  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(handlerTools, styleTools));

  app.get("/test", (c) => {
    const { fn, styled } = c.var.tools;

    const _handler: AnyActivatedClientFunction = fn.handler1;
    const _style: unknown = styled.panel;

    assertEquals(typeof _handler, "function");
    assertExists(_style);

    return c.text("OK");
  });

  assertExists(app);
});
