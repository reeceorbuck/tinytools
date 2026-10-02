import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { parseHTML } from "linkedom";
import {
  NewPartial,
  PartialReplaceWithCache,
} from "../components/NewPartial.tsx";
import { tiny } from "../honoFactory.tsx";
import { ClientRoutes } from "../components/ClientRoutes.tsx";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";

Deno.test("NewPartial emits cache registration only when opted in", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core());
  app.get("/:page", async (context) => {
    const { fn } = await tiny.imports(partialInsertHandlers);
    return context.render(
      <NewPartial
        id="panel"
        cache={context.req.param("page") === "scoped"
          ? "/scoped{/:page}?"
          : ["cached", "api"].includes(context.req.param("page"))}
        onLoad={fn.partialReplace}
      >
        <input value="initial" />
      </NewPartial>,
    );
  });
  const cached = await (await app.request("/cached?ignored=1")).text();
  assertStringIncludes(cached, 'path="/cached" update-path="/cached"');
  const api = await (await app.request("/api", {
    headers: { "destination-url": "/patients/5?tab=chart" },
  })).text();
  assertStringIncludes(api, 'update-path="/patients/5"');
  assertMatch(
    cached,
    /tt-handler-load="\w+\.observeRouteCache"/i,
  );
  assertEquals((cached.match(/<template\b/g) ?? []).length, 4);
  assertStringIncludes(cached, "<client-router");
  assertStringIncludes(cached, '<client-route path="/cached"');
  assertStringIncludes(cached, "<cache-collector");
  assertStringIncludes(cached, 'once="true"');
  assertEquals(cached.includes("from-partial-id"), false);
  assertEquals(cached.includes("data-client-route-active-path"), false);
  assertEquals(/tt-handler-leave|snapshotRoute/.test(cached), false);
  assertEquals(cached.includes(' cache="'), false);
  const scoped = await (await app.request("/scoped")).text();
  assertStringIncludes(scoped, '<client-route path="/scoped{/:page}?"');
  assertStringIncludes(scoped, 'for-partial-id="panel"');
  assertStringIncludes(scoped, 'cache-partial-id="panel"');
  assertStringIncludes(scoped, 'cache-owner-id="panel"');
  assertMatch(
    scoped,
    /<client-router[^>]*tt-handler-load="\w+\.applyNavigationListener \w+\.applyIncomingDataListener"/,
  );
  assertMatch(
    scoped,
    /<client-router[^>]*tt-handler-incomingdata="\w+\.updateCachedRoutes"/,
  );
  const uncached = await (await app.request("/uncached")).text();
  assertEquals((uncached.match(/<template\b/g) ?? []).length, 1);
  assertEquals(uncached.includes("onLoadCacheTemplate"), false);
  assertEquals(
    /observeRouteCache|suspendRouteCache|data-cache-|client-router/.test(
      uncached,
    ),
    false,
  );
});

Deno.test("NewPartial full page loads render directly and retain cache restoration metadata", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core());
  app.get("/:page", async (context) => {
    const { fn } = await tiny.imports(partialInsertHandlers);
    return context.render(
      <section id="panel">
        <NewPartial
          id="panel"
          fullPageLoad
          cache={context.req.param("page") === "cached"}
          groupName="items"
          data-restore="retained"
          onLoad={fn.partialReplace}
        >
          <input value="initial" />
        </NewPartial>
      </section>,
    );
  });
  const cached = await (await app.request("/cached")).text();
  const { document } = parseHTML(cached);
  const panel = document.getElementById("panel")!;
  assertEquals(panel.firstElementChild?.tagName, "INPUT");
  assertEquals(panel.children.length, 3);
  assertEquals(panel.children[1]?.tagName, "CACHE-COLLECTOR");
  assertEquals(panel.lastElementChild?.getAttribute("rel"), "modulepreload");
  assertEquals((cached.match(/<template\b/g) ?? []).length, 3);
  assertEquals(
    (cached.match(/tt-handler-load="\w+\.passLoadEvent"/gi) ?? []).length,
    1,
  );
  assertStringIncludes(cached, '<client-route path="/cached"');
  assertStringIncludes(cached, 'cache-partial-id="panel"');
  assertStringIncludes(cached, 'group-name="items"');
  assertStringIncludes(cached, 'data-restore="retained"');
  assertMatch(cached, /tt-handler-load="\w+\.partialReplace"/i);
  assertMatch(cached, /tt-handler-load="\w+\.observeRouteCache"/i);
  assertStringIncludes(cached, "<cache-collector");
  assertEquals(cached.includes("[object Object]"), false);
  assertEquals(/fullpageload/i.test(cached), false);

  const uncached = await (await app.request("/uncached")).text();
  assertStringIncludes(
    uncached,
    '<section id="panel"><input value="initial"/></section>',
  );
  assertEquals(uncached.includes("<template"), false);
  assertEquals(/onload="handlers\.passLoadEvent_/i.test(uncached), false);
});

Deno.test("PartialReplaceWithCache forwards fullPageLoad without changing partial navigation", async () => {
  const app = new Hono().use(...tiny.middleware.core());
  app.get("/page", (context) =>
    context.render(
      <section id="panel">
        <PartialReplaceWithCache
          id="panel"
          path="/page{/:child}?"
          updatePath="/appointments/2026-10-02/:patientId"
          fullPageLoad={!context.req.header("source-url")}
        >
          <input value="initial" />
        </PartialReplaceWithCache>
      </section>,
    ));
  for (const fullPageLoad of [true, false]) {
    const response = await app.request("/page", {
      headers: fullPageLoad ? {} : { "source-url": "http://localhost/other" },
    });
    const html = await response.text();
    const { document } = parseHTML(html);
    assertEquals(
      document.getElementById("panel")?.firstElementChild?.tagName,
      fullPageLoad ? "INPUT" : "TEMPLATE",
    );
    assertStringIncludes(html, '<client-route path="/page{/:child}?"');
    assertStringIncludes(
      html,
      '<client-route path="/page{/:child}?" update-path="/appointments/2026-10-02/:patientId"',
    );
    assertEquals((html.match(/update-path=/g) ?? []).length, 1);
    assertEquals(/fullpageload|updatepath/i.test(html), false);
  }
});

Deno.test("plain ClientRoutes don't listen for incoming data", async () => {
  const app = new Hono().use(...tiny.middleware.core());
  app.get("/", (context) => context.render(<ClientRoutes />));
  const html = await (await app.request("/")).text();
  assertStringIncludes(html, "<client-router");
  assertEquals(/incomingdata|IncomingData/.test(html), false);
});
