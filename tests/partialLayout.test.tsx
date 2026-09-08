import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { tiny } from "../honoFactory.tsx";

Deno.test("partialLayout lets nested callbacks decide partial response content", async () => {
  for (const sourcePath of [undefined, "/outside", "/nested/previous"]) {
    const sources: Array<string | undefined> = [];
    let outerCalls = 0;
    const app = new Hono().use(...tiny.middleware.core());
    app.use(tiny.middleware.layout(({ children }) => {
      outerCalls++;
      return <div id="outer-layout">{children}</div>;
    }));
    const nested = new Hono().use(
      tiny.middleware.partialLayout(async ({ children }, context) => {
        const source = context.req.header("source-url");
        sources.push(source);
        await Promise.resolve();
        return source?.startsWith("/nested/")
          ? <>{children}</>
          : <section id="nested-layout">{children}</section>;
      }),
    );
    nested.get("/page", (context) =>
      context.render(<p>Nested content</p>));
    app.route("/nested", nested);

    const response = await app.request("/nested/page", {
      headers: sourcePath ? { "source-url": sourcePath } : {},
    });
    const body = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(body, "<p>Nested content</p>");
    assertEquals(body.includes('id="outer-layout"'), !sourcePath);
    assertEquals(outerCalls > 0, !sourcePath);
    assertEquals(
      body.includes('id="nested-layout"'),
      sourcePath !== "/nested/previous",
    );
    assertEquals(sources.length > 0, true);
    assertEquals(sources.every((source) => source === sourcePath), true);
  }
});