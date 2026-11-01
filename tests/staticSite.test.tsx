/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { disableSSG, ssgParams } from "hono/ssg";
import { readFile, rm } from "node:fs/promises";
import { buildStaticSite, staticSiteFetch } from "../build.ts";
import { Handlers, imports } from "../clientTools.ts";
import { tiny } from "../honoFactory.tsx";
import { runtimeScriptPath } from "../honoFactory.tsx";

const root = "./.test-static-site";

const pageHandlers = new Handlers(import.meta.url, {
  greet(this: HTMLButtonElement) {
    this.textContent = "Hello";
  },
});

function createApp() {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.layout(({ children }, c) => (
      <body>
        <nav>
          <a href="/">Home</a> <a href="/about">About</a>{" "}
          <a href="/items/linked">Linked</a> <a href="/logo.svg">Logo</a>{" "}
          <a href="https://example.org/elsewhere">Elsewhere</a>
        </nav>
        <main id="page" data-url={c.req.url}>{children}</main>
      </body>
    )));
  app.get("/", async (c) => {
    const { fn } = await imports(pageHandlers);
    return c.render(<button type="button" onClick={fn.greet}>Home</button>);
  });
  app.get("/about", (c) => c.render(<p>About us</p>));
  app.get(
    "/items/:id",
    ssgParams([{ id: "first" }]),
    (c) => c.render(<p>Item {c.req.param("id")}</p>),
  );
  const section = new Hono().use(tiny.middleware.partialLayout(
    ({ children }, c) =>
      c.req.header("source-url")?.startsWith("/section")
        ? <>{children}</>
        : <section id="section-layout">{children}</section>,
  ));
  section.get("/page", (c) => c.render(<p>Section page</p>));
  app.route("/section", section);
  app.get("/old", (c) => c.redirect("/about", 301));
  app.get("/live", disableSSG(), (c) => c.text("dynamic"));
  app.notFound((c) => c.render(<p>Nothing here</p>));
  return app;
}

Deno.test({
  name: "buildStaticSite renders pages, partials and their assets",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await rm(root, { recursive: true, force: true });
    try {
      const { pages, files } = await buildStaticSite(createApp(), {
        outDir: `${root}/dist`,
        publicDir: `${root}/public`,
        origin: "https://example.com",
      });
      const read = (path: string) => readFile(`${root}/dist/${path}`, "utf-8");

      assertEquals(
        pages.toSorted(),
        ["/", "/about", "/items/first", "/items/linked", "/section/page"],
      );

      const home = await read("index.html");
      assertStringIncludes(
        home,
        '<meta name="tt-partials" content="/_partials">',
      );
      assertStringIncludes(home, '<meta http-equiv="Content-Security-Policy"');
      assertStringIncludes(home, 'data-url="https://example.com/"');
      assertStringIncludes(home, `src="${runtimeScriptPath()}"`);

      // Partials are what a server answers a partial navigation with.
      const aboutPartial = await read("_partials/about.html");
      assertStringIncludes(aboutPartial, "<update");
      assertStringIncludes(aboutPartial, "<p>About us</p>");
      assert(!aboutPartial.includes("<nav>"));
      assert(!aboutPartial.includes("tt-partials"));

      // A partial serves every source page, so it holds the section layout.
      assertStringIncludes(
        await read("_partials/section/page.html"),
        'id="section-layout"',
      );
      assertStringIncludes(await read("items/first.html"), "Item first");
      assertStringIncludes(await read("items/linked.html"), "Item linked");
      assertStringIncludes(
        await read("old.html"),
        'http-equiv="refresh" content="0;url=/about"',
      );
      assertStringIncludes(await read("404.html"), "Nothing here");
      assert(!files.includes("live.html"));

      // Every script a page links is in the build.
      for (const [, src] of home.matchAll(/src="([^"]+)"/g)) {
        assert(files.includes(src.slice(1)), `missing ${src}`);
      }
      assert(
        files.some((file) => /^handlers\/staticSite_test_\w+\.js$/.test(file)),
      );

      const fetch = staticSiteFetch(`${root}/dist`);
      const about = await fetch(new Request("https://example.com/about"));
      assertEquals(about.status, 200);
      assertStringIncludes(await about.text(), "About us");
      const missing = await fetch(new Request("https://example.com/missing"));
      assertEquals(missing.status, 404);
      assertStringIncludes(await missing.text(), "Nothing here");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

Deno.test("buildStaticSite refuses an outDir that holds the public directory", async () => {
  let error: unknown;
  try {
    await buildStaticSite(createApp(), { outDir: ".", publicDir: "./public" });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error);
  assertStringIncludes(error.message, "would replace");
});
