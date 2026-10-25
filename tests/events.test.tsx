/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { generateHandlerHash, Handlers, Styles } from "../clientTools.ts";
import { tiny } from "../mod.ts";
import { runHandlerScript, runtimeScriptPath } from "../honoFactory.tsx";
import { eventHandlerBody } from "../eventAttributes.ts";
import { lifecycleRuntimeScript } from "../lifecycleElement.ts";
import { jsx, jsxAttr, jsxs } from "../jsx-runtime.ts";
import { jsxDEV } from "../jsx-dev-runtime.ts";
import { ActivateParsedHandler } from "../components/ActivateOnLoadHandler.tsx";

const handlers = new Handlers(import.meta.url, {
  click(this: HTMLButtonElement, event: MouseEvent) {
    this.textContent = event.type;
  },
  keyboard(event: KeyboardEvent) {
    console.log(event.key);
  },
});
const unrelated = new Handlers(import.meta.url, {
  unrelatedClick(event: MouseEvent) {
    console.log(event.type);
  },
});
const styles = new Styles(import.meta.url, { button: "color: red;" });

Deno.test("partial responses use reference bindings whether or not CSP is enabled", async () => {
  for (const csp of [true, false]) {
    const app = new tiny.Hono({ tools: "core", csp });
    app.get("/", (context) => context.render(<div>Updated</div>));
    const response = await app.request("/", {
      headers: { "source-url": "http://localhost/previous" },
    });
    const html = await response.text();
    assertEquals(response.status, 200, html);
    assertStringIncludes(html, "<update>");
    assertEquals(html.includes("[object Object]"), false);
    for (const name of ["cacheRoute", "importIntoHead"]) {
      assertMatch(html, new RegExp(`tt-handler-load="\\w+\\.${name}"`));
    }
    assertEquals(html.includes("handlers."), false);
    assertStringIncludes(html, eventHandlerBody);
  }
});

Deno.test("package lifecycle components transform references with the package JSX runtime", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) =>
    context.html(
      await ActivateParsedHandler({ children: jsx("template", {}) }),
    ));
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  assertEquals(html.includes("[object Object]"), false);
  assertMatch(
    html,
    /<template><\/template><link rel="modulepreload" href="\/handlers\/ActivateOnLoadHandler_\w+\.js" tt-handler-load="ActivateOnLoadHandler_\w+\.referParsed"/,
  );
  assertStringIncludes(html, eventHandlerBody);
});

for (const mode of ["core"] as const) {
  for (const constructor of [false, true]) {
    Deno.test(`CSP defaults on and supports opt-out: ${mode}, constructor=${constructor}`, async () => {
      const [lifecycleHash, eventHash] = await Promise.all(
        [
          lifecycleRuntimeScript,
          eventHandlerBody,
        ].map(async (source) => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(source),
          );
          return btoa(String.fromCharCode(...new Uint8Array(digest)));
        }),
      );
      const expected =
        `script-src 'self' 'sha256-${lifecycleHash}'; script-src-attr 'unsafe-hashes' 'sha256-${eventHash}'`;

      for (const csp of [undefined, true, false]) {
        const app = constructor
          ? new tiny.Hono({ tools: mode, csp })
          : new Hono().use(...tiny.middleware[mode]({ csp }));
        app.get("/", (context) => context.html("<button>Events</button>"));
        const response = await app.request("/");
        assertEquals(response.status, 200);
        assertEquals(
          response.headers.get("Content-Security-Policy"),
          csp === false ? null : expected,
        );
        assertEquals(await response.text(), "<button>Events</button>");
      }
    });
  }
}

Deno.test("pages load the dispatcher from a content-hashed, immutably cached URL", async () => {
  const clicks = new tiny.Handlers(import.meta.url, {
    go(this: HTMLElement) {
      this.hidden = true;
    },
  });
  const app = new tiny.Hono({ tools: "core" });
  app.get("/plain", (context) => context.render(<div>Events</div>));
  app.get("/", async (context) => {
    const { fn } = await tiny.imports(clicks);
    return context.render(<button onClick={fn.go}>Events</button>);
  });
  // A page that binds no handler loads no script at all.
  const plain = await (await app.request("/plain")).text();
  assertEquals(plain.includes("<script"), false);
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  // No inline script: a blocking classic script at the end of the head.
  assertEquals(html.includes("<script>"), false);
  const src = html.match(/<script src="([^"]+)"><\/script><\/head>/)?.[1];
  assertEquals(src, runtimeScriptPath());
  // Named like a handler bundle, by the hash of its content, so a changed
  // runtime is a new URL while the old one stays cached.
  assertEquals(
    src,
    `/handlers/tt-runtime_${generateHandlerHash(runHandlerScript)}.js`,
  );
  const script = await app.request(src!);
  assertEquals(script.status, 200);
  assertEquals(
    script.headers.get("Content-Type"),
    "application/javascript; charset=utf-8",
  );
  assertEquals(
    script.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  const body = await script.text();
  assertEquals(body, runHandlerScript);
  assertStringIncludes(body, "const tiny = {runHandler};");
  assertEquals(body.includes("defineLifecycleElement"), false);
  const scriptPolicy = response.headers.get("Content-Security-Policy")?.split(
    ";",
  )[0];
  assertMatch(
    scriptPolicy ?? "",
    /^script-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/,
  );
});

Deno.test("CSP opt-out preserves application policies", async () => {
  const plain = new tiny.Hono();
  plain.get("/", (context) => context.text("OK"));
  assertEquals(
    (await plain.request("/")).headers.get("Content-Security-Policy"),
    null,
  );

  const custom = new Hono()
    .use(async (context, next) => {
      context.header(
        "Content-Security-Policy",
        "script-src 'self' 'unsafe-inline'",
      );
      await next();
    })
    .use(...tiny.middleware.core({ csp: false }));
  custom.get("/", (context) => context.text("OK"));
  assertEquals(
    (await custom.request("/")).headers.get("Content-Security-Policy"),
    "script-src 'self' 'unsafe-inline'",
  );
});

Deno.test("fn references render in requests and record accessed handler files", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core());

  app.get("/", async (context) => {
    const { fn } = await tiny.imports(handlers, styles);
    const other = await tiny.imports(unrelated);
    assertStringIncludes(
      String(
        <button type="button" onClick={other.fn.unrelatedClick}>Other</button>,
      ),
      `onclick="${eventHandlerBody}"`,
    );
    const button = String(
      <button type="button" onClick={fn.click} onMouseOver={fn.click}>
        Events
      </button>,
    );
    const handler = /tt-handler-click="([^"]+)"/.exec(button)?.[1];
    assertMatch(handler ?? "", /^events_test_\w+\.click$/);
    assertStringIncludes(button, `tt-handler-mouseover="${handler}"`);
    assertEquals(
      (context.var as unknown as { accessedHandlerFiles: Set<string> })
        .accessedHandlerFiles.has(handler!.split(".")[0] + ".js"),
      true,
    );
    return context.html(button);
  });
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  assertMatch(html, /tt-handler-click="events_test_\w+\.click"/);
  assertMatch(html, /tt-handler-mouseover="events_test_\w+\.click"/);
});

Deno.test("fn references render the same across CSP modes and JSX runtimes", async () => {
  await Promise.all([true, false, true, false].map(async (csp) => {
    const app = new tiny.Hono({ tools: "core", csp });
    app.get("/", async (context) => {
      const { fn } = await tiny.imports(handlers);
      await Promise.resolve();
      assertEquals(typeof fn.click, "object");
      const single =
        /^<button onclick="tiny\.runHandler\(this,event\)" tt-handler-click="events_test_\w+\.click"><\/button>$/;
      const multiple =
        /^<button onclick="tiny\.runHandler\(this,event\)" tt-handler-click="(events_test_\w+\.click) \1"><\/button>$/;
      for (const render of [jsx, jsxs, jsxDEV]) {
        assertMatch(String(render("button", { onClick: fn.click })), single);
        assertMatch(
          String(render("button", { onClick: [fn.click, fn.click] })),
          multiple,
        );
      }
      assertMatch(
        `<button ${jsxAttr("onClick", fn.click)}></button>`,
        single,
      );
      assertMatch(
        `<button ${jsxAttr("onClick", [fn.click, fn.click])}></button>`,
        multiple,
      );
      return context.text("OK");
    });
    const response = await app.request("/");
    assertEquals(await response.text(), "OK");
    assertEquals(response.status, 200);
  }));
});
