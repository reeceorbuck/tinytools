import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { tiny } from "../honoFactory.tsx";
import {
  GENERATED_HANDLER_HASH_LENGTH,
  GENERATED_STYLE_HASH_LENGTH,
  generateHandlerHash,
  generateStyleHash,
  Handlers,
  Styles,
} from "../clientTools.ts";
import { eventHandlerBody } from "../eventAttributes.ts";

const first = new Handlers(import.meta.url, {
  click() {
    console.log("first");
  },
  unused() {
    console.log("unused");
  },
});
const second = new Handlers(import.meta.url, {
  click() {
    console.log("second");
  },
  submit(event: SubmitEvent) {
    event.preventDefault();
  },
});
const styles = new Styles(import.meta.url, {
  panel: "color: red;",
  alternate: "color: green;",
});

Deno.test("core supports clamped and separate hash lengths", () => {
  try {
    tiny.middleware.core({ generatedFilenameHashLength: 3 });
    assertEquals(generateHandlerHash("test").length, 3);
    assertEquals(generateStyleHash("test").length, 3);
    tiny.middleware.core({ generatedFilenameHashLength: 99 });
    assertEquals(generateHandlerHash("test").length, 8);
    tiny.middleware.core({ generatedFilenameHashLength: 0 });
    assertEquals(generateStyleHash("test").length, 1);
    tiny.middleware.core({
      generatedHandlerHashLength: 6,
      generatedStyleHashLength: 4,
    });
    assertEquals(generateHandlerHash("test").length, 6);
    assertEquals(generateStyleHash("test").length, 4);
  } finally {
    tiny.middleware.core({
      generatedHandlerHashLength: GENERATED_HANDLER_HASH_LENGTH,
      generatedStyleHashLength: GENERATED_STYLE_HASH_LENGTH,
    });
  }
});

Deno.test("core loads only the dispatcher plus accessed handler and style assets", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { fn, styled } = await tiny.imports(first, styles);
    assertEquals(Reflect.get(context.var, "tools"), undefined);
    return context.render(
      <button onClick={fn.click} class={styled.panel}>Home</button>,
    );
  });
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  const dispatcher = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert(dispatcher);
  const element = {
    getAttribute(name: string) {
      assertEquals(name, "tt-handler-click");
      return "";
    },
  };
  new Function("event", `${dispatcher}\n${eventHandlerBody}`).call(
    element,
    new Event("click"),
  );
  assertStringIncludes(
    html,
    `/handlers/${first._handlerFilenames.get("click")}.js`,
  );
  assertStringIncludes(
    html,
    `/styles/${styles._styleFilenames.get("panel")}.css`,
  );
  // Handlers of one instance share a bundle; other instances are not loaded.
  assertEquals(
    first._handlerFilenames.get("unused"),
    first._handlerFilenames.get("click"),
  );
  assertEquals(
    html.includes(`/handlers/${second._handlerFilenames.get("click")}.js`),
    false,
  );
  assertEquals(html.includes("/_tinytools/"), false);
});

Deno.test("imports do not leak handlers or assets between calls and concurrent requests", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/:collection", async (context) => {
    const local = await tiny.imports(
      context.req.param("collection") === "first" ? first : second,
    );
    const empty = await tiny.imports();
    assertEquals(Reflect.get(empty.handlers, "click"), undefined);
    await Promise.resolve();
    return context.render(<button onClick={local.fn.click}>Click</button>);
  });
  const [firstHtml, secondHtml] = await Promise.all(
    ["first", "second"].map(async (path) =>
      (await app.request(`/${path}`)).text()
    ),
  );
  assertStringIncludes(firstHtml, first._handlerFilenames.get("click")!);
  assertEquals(
    firstHtml.includes(second._handlerFilenames.get("click")!),
    false,
  );
  assertStringIncludes(secondHtml, second._handlerFilenames.get("click")!);
  assertEquals(
    secondHtml.includes(first._handlerFilenames.get("click")!),
    false,
  );
});

Deno.test("explicit imports use last collection precedence without mutating collections", async () => {
  const combined = await tiny.imports(first, second, styles);
  const original = await tiny.imports(first);
  const override = await tiny.imports(second);
  assertEquals(combined.handlers.click, override.handlers.click);
  assertEquals(combined.handlers.click === original.handlers.click, false);
  assertEquals(typeof combined.handlers.unused, "string");
  assertEquals(typeof combined.handlers.submit, "string");
  assertEquals(typeof combined.styled.panel, "string");
  assertEquals(Reflect.get(original.handlers, "submit"), undefined);
});

Deno.test("imports retain inline composition and style merging", async () => {
  const { handlers, styled } = await tiny.imports(first, second, styles);
  const independent = handlers.multiHandler(handlers.click, handlers.submit);
  const sequential = handlers.multiHandlerSync(handlers.click, handlers.submit);
  assertStringIncludes(String(independent), ".call(this, event);handlers.");
  assertStringIncludes(String(sequential), "if(await handlers.");
  assertStringIncludes(String(sequential), "===false)return;");
  const merged = styled.mergeClasses(
    styled.panel,
    styled.alternate,
    styled.panel,
  );
  assertEquals(new Set(merged.split(" ")).size, merged.split(" ").length);
});

Deno.test("imports outside requests expose tools but reject context access", async () => {
  const local = await tiny.imports(first);
  assertEquals(typeof local.handlers.click, "string");
  assertThrows(() => local.c, Error, "no active Hono request context");
  await assertRejects(
    () => tiny.imports(),
    Error,
    "at least one TinyTools instance",
  );
});

Deno.test("handler constructor dependencies remain available through imports", async () => {
  const combined = new Handlers(import.meta.url, { imports: [first] }, {
    own() {
      console.log("own");
    },
  });
  const { handlers } = await tiny.imports(combined);
  assertEquals(typeof handlers.click, "string");
  assertEquals(typeof handlers.own, "string");
  assertThrows(
    () =>
      new Handlers(import.meta.url, { imports: [first] }, {
        click() {
          console.log("duplicate");
        },
      }),
    Error,
    "click",
  );
});

Deno.test("reserved handler and style names remain rejected", () => {
  for (const name of ["multiHandler", "multiHandlerSync"]) {
    assertThrows(
      () => new Handlers(import.meta.url, { [name]() {} }),
      Error,
      name,
    );
  }
  assertThrows(
    () =>
      new Styles(import.meta.url, {
        // @ts-expect-error Reserved names are rejected at type and runtime levels.
        mergeClasses: "color: red;",
      }),
    Error,
    "mergeClasses",
  );
});

for (const partialLayout of [false, true]) {
  Deno.test(`layout renders once and tracks asynchronous assets, partial=${partialLayout}`, async () => {
    let renders = 0;
    const layout = partialLayout
      ? tiny.middleware.partialLayout
      : tiny.middleware.layout;
    const app = new tiny.Hono({ tools: "core" }).use(
      layout(async ({ children }) => {
        renders++;
        const { fn, styled } = await tiny.imports(first, styles);
        return (
          <body class={styled.panel}>
            <nav onClick={fn.click}>Navigation</nav>
            {children}
          </body>
        );
      }),
    );
    app.get("/", (context) => context.render(<main>Content</main>));
    const full = await (await app.request("/")).text();
    assertEquals(renders, 1);
    assertEquals((full.match(/<body\b/g) ?? []).length, 1);
    assertStringIncludes(
      full,
      `/styles/${styles._styleFilenames.get("panel")}.css`,
    );
    assertStringIncludes(
      full,
      `/handlers/${first._handlerFilenames.get("click")}.js`,
    );
    const partial = await (await app.request("/", {
      headers: { "source-url": "http://localhost/previous" },
    })).text();
    assertEquals(renders, partialLayout ? 2 : 1);
    assertEquals(partial.includes("Navigation"), partialLayout);
    assertStringIncludes(partial, "Content");
    assertEquals(partial.includes("/_tinytools/"), false);
  });
}

Deno.test("TinyHono forwards a custom static adapter and caches generated assets", async () => {
  let root: string | undefined;
  const app = new tiny.Hono({
    tools: "core",
    serveStatic(options) {
      root = options.root;
      return async (context, next) => {
        if (context.req.path === "/styles/test.css") {
          options.onFound("public/styles/test.css", context);
          return context.text("body {}");
        }
        options.onNotFound(context.req.path, context);
        await next();
      };
    },
  });
  app.get("*", (context) => context.text("route"));
  const asset = await app.request("/styles/test.css");
  assertEquals(await asset.text(), "body {}");
  assertEquals(root, "./public/");
  assertStringIncludes(asset.headers.get("cache-control")!, "immutable");
  const missing = await app.request("/missing.js");
  assertEquals(missing.status, 404);
  await missing.text();
  const api = await app.request("/api/record.json");
  assertEquals(await api.text(), "route");
});

Deno.test("removed package client assets are not served", async () => {
  const app = new tiny.Hono({ tools: "core" });
  const response = await app.request(
    "/_tinytools/eventHandlers.js",
  );
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("cache-control"), null);
  await response.body?.cancel();
});
