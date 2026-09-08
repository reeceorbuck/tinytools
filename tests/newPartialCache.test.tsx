import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { NewPartial, tiny } from "../honoFactory.tsx";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";

Deno.test("NewPartial emits cache registration only when opted in", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(partialInsertHandlers));
  app.get("/:page", (context) => {
    const { fn } = context.var.tools;
    return context.render(
      <NewPartial
        id="panel"
        cache={context.req.param("page") === "scoped"
          ? "/scoped{/:page}?"
          : context.req.param("page") === "cached"}
        onLoad={fn.partialReplace}
      >
        <input value="initial" />
      </NewPartial>,
    );
  });
  const cached = await (await app.request("/cached?ignored=1")).text();
  assertStringIncludes(cached, 'path="/cached"');
  assertMatch(
    cached,
    /onload="handlers\.registerRouteCache_[a-z0-9]+\.call\(this, event\)"/i,
  );
  assertEquals((cached.match(/<template\b/g) ?? []).length, 4);
  assertStringIncludes(cached, "<client-router");
  assertStringIncludes(cached, '<client-route path="/cached"');
  assertStringIncludes(cached, 'from-partial-id="panel"');
  assertEquals(/tt-handler-leave|snapshotRoute/.test(cached), false);
  assertEquals(cached.includes(' cache="'), false);
  const scoped = await (await app.request("/scoped")).text();
  assertStringIncludes(scoped, '<client-route path="/scoped{/:page}?"');
  assertStringIncludes(scoped, 'from-partial-id="panel"');
  const uncached = await (await app.request("/uncached")).text();
  assertEquals((uncached.match(/<template\b/g) ?? []).length, 1);
  assertEquals(uncached.includes("onLoadCacheTemplate"), false);
  assertEquals(
    /registerRouteCache|snapshotRoute|data-cache-|client-router/.test(uncached),
    false,
  );
});
