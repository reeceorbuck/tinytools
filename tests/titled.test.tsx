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
    "<head-update><title>Recalls Due</title>",
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
