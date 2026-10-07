import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { Handlers, Styles } from "../clientTools.ts";
import { tiny } from "../mod.ts";
import { runHandlerScript } from "../honoFactory.tsx";
import { eventHandlerBody } from "../eventAttributes.ts";
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

Deno.test("partial responses use reference bindings unless CSP is disabled", async () => {
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
      assertEquals(
        new RegExp(`tt-handler-load="\\w+\\.${name}"`).test(html),
        csp,
      );
      assertEquals(
        new RegExp(
          `onload="handlers\\.\\w+\\.${name}\\.call\\(this, event\\)"`,
          "i",
        ).test(html),
        !csp,
      );
    }
    if (csp) assertStringIncludes(html, eventHandlerBody);
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
      const [scriptHash, eventHash] = await Promise.all(
        [
          runHandlerScript,
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
        `script-src 'self' 'sha256-${scriptHash}'; script-src-attr 'unsafe-hashes' 'sha256-${eventHash}'`;

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

Deno.test("CSP hash matches the inline runHandler script in rendered pages", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) => context.render(<div>Events</div>));
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assertEquals(script, runHandlerScript);
  // The runtime defining lifecycle tags ships in the same hashed script.
  assertStringIncludes(script!, "function defineLifecycleElement(");
  assertStringIncludes(script!, "defineLifecycleTags();");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(script),
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const scriptPolicy = response.headers.get("Content-Security-Policy")?.split(
    ";",
  )[0];
  assertEquals(scriptPolicy, `script-src 'self' 'sha256-${hash}'`);
});

Deno.test("CSP middleware works standalone and opt-out preserves application policies", async () => {
  const standalone = new Hono().use(tiny.middleware.csp());
  standalone.get("/", () => new Response("OK"));
  const response = await standalone.request("/");
  assertMatch(
    response.headers.get("Content-Security-Policy") ?? "",
    /^script-src 'self' 'sha256-[A-Za-z0-9+/=]+'; script-src-attr 'unsafe-hashes' 'sha256-[A-Za-z0-9+/=]+'$/,
  );
  assertEquals(await response.text(), "OK");

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

Deno.test("events work alongside legacy handlers in request rendering and local imports", async () => {
  let expectedButton = "";
  const app = new Hono()
    .use(...tiny.middleware.core());

  app.get("/", async (context) => {
    const { handlers: legacy, events, fn: references } = await tiny.imports(
      handlers,
      styles,
    );
    const local = await tiny.imports(handlers);
    const other = await tiny.imports(unrelated);
    assertEquals(
      String(local.events({ click: local.fn.click }).onclick),
      eventHandlerBody,
    );
    const attributes = events({
      click: references.click,
      mouseover: references.click,
    });
    expectedButton = String(
      <button type="button" {...attributes}>Events</button>,
    );
    assertEquals(attributes, events({ click: "click", mouseover: "click" }));
    assertEquals(
      String(
        other.events({
          click: other.fn.unrelatedClick,
        }).onclick,
      ),
      eventHandlerBody,
    );
    assertEquals(attributes.onclick, attributes.onmouseover);
    assertEquals(
      (context.var as unknown as { accessedHandlerFiles: Set<string> })
        .accessedHandlerFiles.has(
          attributes["tt-handler-click"].split(".")[0] + ".js",
        ),
      true,
    );
    return context.html(
      <div>
        <button type="button" onClick={legacy.click}>Inline</button>
        <button type="button" {...attributes}>Events</button>
      </div>,
    );
  });
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  assertMatch(
    html,
    /onClick="handlers\.events_test_\w+\.click\.call\(this, event\)"/i,
  );
  assertMatch(html, /tt-handler-click="events_test_\w+\.click"/);
  assertStringIncludes(html, expectedButton);
});

async function checkImportTypes() {
  const { handlers: legacy, events } = await tiny.imports(handlers, styles);
  events({ click: "click", keydown: "keyboard" });
  // @ts-expect-error Names must come from the explicit imports.
  events({ click: "unrelatedClick" });
  // @ts-expect-error Keyboard handlers cannot handle mouse events.
  events({ click: "keyboard" });
  // @ts-expect-error Activated inline expressions are not handler names.
  events({ click: legacy.click });
  const onlyStyles = await tiny.imports(styles);
  // @ts-expect-error Styles do not import handlers.
  onlyStyles.events({ click: "click" });
  const extended = await tiny.imports(handlers, unrelated);
  extended.events({ click: "unrelatedClick", keydown: "keyboard" });
}
void checkImportTypes;

Deno.test("fn references and legacy handlers stay isolated across CSP modes and JSX runtimes", async () => {
  await Promise.all([true, false, true, false].map(async (csp) => {
    const app = new tiny.Hono({ tools: "core", csp });
    app.get("/", async (context) => {
      const { fn, handlers: legacy } = await tiny.imports(handlers);
      await Promise.resolve();
      assertEquals(typeof fn.click, "object");
      assertEquals(typeof legacy.click, "string");
      for (const render of [jsx, jsxs, jsxDEV]) {
        const html = String(render("button", { onClick: fn.click }));
        assertEquals(html.includes("tt-handler-click="), csp);
        assertStringIncludes(
          html,
          csp ? eventHandlerBody : String(legacy.click),
        );
        const legacyHtml = String(render("button", { onClick: legacy.click }));
        assertEquals(legacyHtml.includes("tt-handler-"), false);
        assertStringIncludes(legacyHtml, String(legacy.click));
        const multipleHtml = String(
          render("button", { onClick: [fn.click, fn.click] }),
        );
        assertEquals(multipleHtml.includes("tt-handler-click="), csp);
        assertStringIncludes(
          multipleHtml,
          csp ? eventHandlerBody : `${legacy.click}; ${legacy.click}`,
        );
      }
      const attribute = String(jsxAttr("onClick", fn.click));
      assertEquals(attribute.includes("tt-handler-click="), csp);
      assertStringIncludes(
        attribute,
        csp ? eventHandlerBody : String(legacy.click),
      );
      const multipleAttribute = String(
        jsxAttr("onClick", [fn.click, fn.click]),
      );
      assertEquals(multipleAttribute.includes("tt-handler-click="), csp);
      assertStringIncludes(
        multipleAttribute,
        csp ? eventHandlerBody : `${legacy.click}; ${legacy.click}`,
      );
      return context.text("OK");
    });
    const response = await app.request("/");
    assertEquals(await response.text(), "OK");
    assertEquals(response.status, 200);
  }));
});
