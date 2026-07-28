/**
 * Tests for Suspense streaming and async component rendering.
 *
 * Verifies that:
 * - Suspense streams fallback then resolved content
 * - Callbacks survive through the core jsxRenderer's await+rewrap pattern
 * - AssetTags are populated after children rendering
 * - Route layouts with Suspense preserve streaming
 *
 * Run with: deno test --check --allow-env --allow-read --allow-write --allow-net tests/suspense.test.tsx
 */

/// <reference lib="dom" />

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { addRouteLayout, tiny } from "../honoFactory.tsx";
import { Suspense } from "../components/Suspense.tsx";
import type { Child, FC } from "hono/jsx";

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: { title?: string },
    ): Response | Promise<Response>;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Collect all chunks from a streaming response */
async function collectChunks(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (text) chunks.push(text);
  }
  return chunks;
}

/** Get the full body text from a response */
async function fullBody(res: Response): Promise<string> {
  return (await collectChunks(res)).join("");
}

/** Simple async component that delays then returns content */
const SlowContent: FC<{ delay?: number; content: string }> = async ({
  delay = 10,
  content,
}) => {
  await new Promise((r) => setTimeout(r, delay));
  return <div class="resolved">{content}</div>;
};

const SlowList: FC<{ items: string[] }> = async ({ items }) => {
  return <>{items.map((item) => <SlowContent content={item} delay={10} />)}</>;
};

/** Sync component */
const SyncContent: FC<{ content: string }> = ({ content }) => {
  return <div class="sync">{content}</div>;
};

/** A simple layout component for testing */
const TestLayout: FC<{ children: Child }> = ({ children }) => {
  return (
    <div id="layout-wrapper">
      <nav>Test Nav</nav>
      <main>{children}</main>
    </div>
  );
};

// ============================================================================
// Tests
// ============================================================================

Deno.test("Suspense - streams fallback then resolved async content", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) =>
      c.render(
        <Suspense fallback={<div>Loading...</div>}>
          <SlowContent content="Hello World" delay={50} />
        </Suspense>,
      ));

  const res = await app.request("/");
  assertEquals(res.status, 200);

  const chunks = await collectChunks(res);
  assert(
    chunks.length >= 2,
    `Expected at least 2 chunks, got ${chunks.length}`,
  );

  // First chunk contains the fallback
  assertStringIncludes(chunks[0], "suspended-");
  assertStringIncludes(chunks[0], "Loading...");

  // Later chunk(s) contain the resolved content
  const laterContent = chunks.slice(1).join("");
  assertStringIncludes(laterContent, "<update");
  assertStringIncludes(laterContent, "Hello World");
  assertStringIncludes(laterContent, "resolved");
});

Deno.test("Suspense - sync children render inline without streaming", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) =>
      c.render(
        <Suspense fallback={<div>Loading...</div>}>
          <SyncContent content="Immediate" />
        </Suspense>,
      ));

  const res = await app.request("/");
  assertEquals(res.status, 200);

  const body = await fullBody(res);
  // Sync children should render directly, no suspended div
  assertStringIncludes(body, "Immediate");
  assertStringIncludes(body, "sync");
  // Should NOT contain update/streaming markers
  assert(
    !body.includes("<update"),
    "Sync children should not produce streaming updates",
  );
});

Deno.test("Suspense - multiple Suspense components stream independently", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) =>
      c.render(
        <>
          <Suspense fallback={<span>Loading A...</span>}>
            <SlowContent content="Content A" delay={30} />
          </Suspense>
          <Suspense fallback={<span>Loading B...</span>}>
            <SlowContent content="Content B" delay={60} />
          </Suspense>
        </>,
      ));

  const res = await app.request("/");
  assertEquals(res.status, 200);

  const body = await fullBody(res);
  assertStringIncludes(body, "Content A");
  assertStringIncludes(body, "Content B");

  // Both should have streaming update markers
  const updateCount = (body.match(/<update /g) || []).length;
  assert(
    updateCount >= 2,
    `Expected at least 2 <update> tags, got ${updateCount}`,
  );
});

Deno.test("Suspense - callbacks survive core jsxRenderer await+rewrap", async () => {
  // This is the critical test for the bug fix:
  // The core jsxRenderer does `await children` (for AssetTags) then re-wraps
  // the result as Promise.resolve() if callbacks exist. Without the re-wrap,
  // childrenToStringToBuffer would do `buffer[0] += child` which drops .callbacks.
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) =>
      c.render(
        <Suspense fallback={<p>Wait...</p>}>
          <SlowContent content="Streamed after await" delay={30} />
        </Suspense>,
      ));

  const res = await app.request("/");
  const chunks = await collectChunks(res);

  // Must be multiple chunks - proves callbacks survived the await+rewrap
  assert(
    chunks.length >= 2,
    `Callbacks lost: expected >=2 chunks but got ${chunks.length}. ` +
      `If only 1 chunk, the streaming callbacks were dropped by childrenToStringToBuffer.`,
  );

  const laterContent = chunks.slice(1).join("");
  assertStringIncludes(laterContent, "Streamed after await");
});

Deno.test("Suspense - works inside route layout", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(addRouteLayout(({ children }) => <TestLayout>{children}</TestLayout>))
    .get("/", (c) =>
      c.render(
        <Suspense fallback={<div>Layout loading...</div>}>
          <SlowContent content="Layout resolved" delay={30} />
        </Suspense>,
      ));

  const res = await app.request("/");
  assertEquals(res.status, 200);

  const chunks = await collectChunks(res);
  assert(
    chunks.length >= 2,
    `Expected streaming with layout, got ${chunks.length} chunks`,
  );

  const body = chunks.join("");
  // Layout wrapper should be present
  assertStringIncludes(body, "layout-wrapper");
  assertStringIncludes(body, "Test Nav");
  // Streamed content should arrive
  assertStringIncludes(body, "Layout resolved");
});

Deno.test("Suspense - partial navigation returns update without full page shell", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) =>
      c.render(
        <Suspense fallback={<div>Loading...</div>}>
          <SlowContent content="Partial content" delay={30} />
        </Suspense>,
        { title: "Partial page title" },
      ));

  const req = new Request("http://localhost/", {
    headers: { "source-url": "/previous" },
  });
  const res = await app.request(req);
  assertEquals(res.status, 200);

  const body = await fullBody(res);
  // Partial navigation wraps in <update><template>...
  assertStringIncludes(body, "<update>");
  assertStringIncludes(body, "<head-update>");
  assertStringIncludes(
    body,
    "<head-update><title>Partial page title</title>",
  );
  assertStringIncludes(body, "<body-update>");
  const bodyUpdate = body.slice(body.indexOf("<body-update>"));
  assert(
    !bodyUpdate.includes("<title>"),
    "Partial title must not be emitted in body-update",
  );
  // Should NOT contain the full <html><head><body> shell
  assert(!body.includes("<html"), "Partial nav should not have html element");
});

Deno.test("core renderer preserves pre-resolved Suspense callbacks", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", async (c) => {
      const suspended = await Suspense({
        fallback: <div>Loading...</div>,
        children: <SlowList items={["Confirmation one", "Confirmation two"]} />,
      });
      return c.render(suspended);
    });

  const res = await app.request(
    new Request("http://localhost/", {
      headers: { "source-url": "/communicator/confirmations/previous" },
    }),
  );
  assertEquals(res.status, 200);

  const chunks = await collectChunks(res);
  assert(
    chunks.length >= 2,
    `Expected partial Suspense completion chunk, got ${chunks.length}`,
  );
  assertStringIncludes(chunks[0], "Loading...");
  assertStringIncludes(chunks.slice(1).join(""), "Confirmation one");
  assertStringIncludes(chunks.slice(1).join(""), "Confirmation two");
});

Deno.test("partial navigation emits styles used by async components", async () => {
  const partialStyles = new tiny.Styles(import.meta.url, {
    partialPanel: tiny.css`
      display: grid;
    `,
  });

  const StyledPartial = async () => {
    const { c, styled } = await tiny.imports(partialStyles);
    const className = styled.partialPanel;
    const accessedStyles = c.get("accessedStyleFiles") as Set<string>;
    assert(
      accessedStyles.size > 0,
      "Style access should reach request tracking",
    );
    return <div class={className}>Styled partial</div>;
  };

  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) => c.render(<StyledPartial />));

  const res = await app.request(
    new Request("http://localhost/", {
      headers: { "source-url": "/previous" },
    }),
  );
  assertEquals(res.status, 200);

  const body = await fullBody(res);
  assertStringIncludes(body, "Styled partial");
  assertStringIncludes(body, 'rel="stylesheet"');
  assertStringIncludes(body, "/styles/");
});

Deno.test("partial navigation without a title omits the title update", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) => c.render(<div>Untitled partial content</div>));

  const res = await app.request(
    new Request("http://localhost/", {
      headers: { "source-url": "/previous" },
    }),
  );
  assertEquals(res.status, 200);

  const body = await fullBody(res);
  assertStringIncludes(body, "<head-update>");
  assert(
    !body.includes("<title>"),
    "A title-less partial must preserve the current document title",
  );
});

Deno.test("Async component - renders without Suspense wrapper", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get(
      "/",
      (c) => c.render(<SlowContent content="Direct async" delay={10} />),
    );

  const res = await app.request("/");
  assertEquals(res.status, 200);

  const body = await fullBody(res);
  assertStringIncludes(body, "Direct async");
  assertStringIncludes(body, '<div class="resolved">Direct async</div>');
});

Deno.test("Async component - full page has html structure", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", (c) => c.render(<SlowContent content="Structured" delay={10} />));

  const res = await app.request("/");
  const body = await fullBody(res);

  assertStringIncludes(body, "<!DOCTYPE html>");
  assertStringIncludes(body, "<html");
  assertStringIncludes(body, "<head>");
  assertStringIncludes(body, "<body>");
  assertStringIncludes(body, "Structured");
});
