/**
 * Public API tests for handler-driven partial insertion.
 */

/// <reference lib="dom" />

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { buildHandlers } from "../build.ts";
import { Partial, type PartialProps } from "../components/Partial.tsx";
import { tiny } from "../honoFactory.tsx";
import { partialInsertHandlers } from "../partialInsertHandlers.ts";

const handlerNames = [
  "partialRouteCache",
  "partialAutofocus",
  "partialAttributes",
  "partialReplace",
  "partialBlast",
  "partialDelete",
  "partialMergeContent",
] as const;

Deno.test("partial insert handlers build as standalone modules", async () => {
  const handlerDirectory = "./.test-build-output/partial-insert-handlers";
  await Deno.remove(handlerDirectory, { recursive: true }).catch(() => {});
  await Deno.mkdir(handlerDirectory, { recursive: true });

  try {
    await buildHandlers(handlerDirectory, { fresh: true });
    const built = [];
    for await (const entry of Deno.readDir(handlerDirectory)) {
      if (entry.isFile && entry.name.endsWith(".js")) built.push(entry.name);
    }
    for (const name of handlerNames) {
      const filename = built.find((entry) => entry.startsWith(`${name}_`));
      assertEquals(typeof filename, "string");
    }
  } finally {
    await Deno.remove(handlerDirectory, { recursive: true }).catch(() => {});
  }
});

Deno.test("partial handlers activate and serialize on Partial", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(partialInsertHandlers));

  app.get("/", (context) => {
    const { fn } = context.var.tools;

    for (const name of handlerNames) {
      assertMatch(
        fn[name] as unknown as string,
        new RegExp(
          `^handlers\\.${name}_[a-z0-9]+\\.call\\(this, event\\)$`,
        ),
      );
    }

    const handlerDrivenProps: PartialProps = {
      id: "typed-partial",
      onMount: fn.partialReplace,
    };
    assertEquals(handlerDrivenProps.id, "typed-partial");
    // @ts-expect-error Every partial requires a mount handler.
    const _handlerlessProps: PartialProps = { id: "handlerless-partial" };

    return context.render(
      <Partial
        id="test-partial"
        onMount={fn.multiHandler(fn.partialRouteCache, fn.partialReplace)}
        groupName="test-group"
      >
        <span>Updated</span>
      </Partial>,
    );
  });

  const response = await app.fetch(new Request("http://localhost/"));
  const html = await response.text();

  assertEquals(response.status, 200, html);
  assertStringIncludes(html, "<partial-content");
  assertStringIncludes(html, 'id="test-partial"');
  assertEquals(html.includes(' mode="'), false);
  assertStringIncludes(html, 'group-name="test-group"');
  assertMatch(
    html,
    /onmount="handlers\.partialRouteCache_[a-z0-9]+\.call\(this, event\);handlers\.partialReplace_[a-z0-9]+\.call\(this, event\)"/i,
  );
  assertEquals(html.includes("handlers.merge"), false);
});
