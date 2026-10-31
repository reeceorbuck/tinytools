/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { tiny } from "../honoFactory.tsx";
import { titled } from "../titled.ts";

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: { title?: string },
    ): Response | Promise<Response>;
  }
}

Deno.test("titled - supplies the full-page document title", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", titled("Communicator", (c) => c.render(<p>Content</p>)));

  const response = await app.request("/");
  assertEquals(response.status, 200);
  assertStringIncludes(await response.text(), "<title>Communicator</title>");
});

Deno.test("titled - supplies the partial head-update title", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get("/", titled("Recalls Due", (c) => c.render(<p>Content</p>)));

  const response = await app.request(
    new Request("http://localhost/", {
      headers: { "source-url": "/communicator/confirmations" },
    }),
  );
  assertEquals(response.status, 200);
  const body = await response.text();
  assertStringIncludes(
    body,
    "<title>Recalls Due</title></template>",
  );
});

Deno.test("titled - explicit render title takes precedence", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .get(
      "/",
      titled(
        "Static title",
        (c) => c.render(<p>Content</p>, { title: "Dynamic title" }),
      ),
    );

  const response = await app.request("/");
  assertEquals(response.status, 200);
  assertStringIncludes(await response.text(), "<title>Dynamic title</title>");
});

Deno.test("render head and lang - full pages only", async () => {
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.layout(({ children }) => <body>{children}</body>))
    .get("/", (c) =>
      // deno-lint-ignore no-explicit-any
      (c.render as any)(<p>Content</p>, {
        title: "Home",
        lang: "en-AU",
        head: <meta name="description" content="A page" />,
      }));

  const full = await (await app.request("/")).text();
  assertStringIncludes(full, '<html lang="en-AU"');
  assertStringIncludes(full, '<meta name="description" content="A page"/>');

  const partial = await (await app.request(
    new Request("http://localhost/", { headers: { "source-url": "/other" } }),
  )).text();
  assertStringIncludes(partial, "<title>Home</title>");
  assertEquals(partial.includes('name="description"'), false);
});
