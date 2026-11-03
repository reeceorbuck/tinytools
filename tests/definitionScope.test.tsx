/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assertEquals, assertMatch } from "@std/assert";
import { Handlers, imports } from "../clientTools.ts";
import { tiny } from "../mod.ts";

// Deno (2.9.8) hands each request the async context of the last dynamic
// import(), so a request can start inside a definition still in progress.
// Serving a request from inside one reproduces that state.
Deno.test("a request rendered inside a definition in progress is outside it", async () => {
  const shared = new Handlers(import.meta.url, {
    ping() {
      console.log("ping");
    },
  });
  async function Uses() {
    const { fn } = await tiny.imports(shared);
    return <button type="button" onClick={fn.ping}>Ping</button>;
  }
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) => context.render(<Uses />));

  let response: Response | undefined;
  const definition = new Handlers(import.meta.url, async () => {
    await imports(shared);
    response = await app.request("/");
    return {
      pong() {
        console.log("pong");
      },
    };
  });
  await definition.ensureDefined();

  // Inside the definition the import fails, which streaming only logs.
  const html = await response!.text();
  assertEquals(response!.status, 200, html);
  assertMatch(html, /<button type="button" onclick="[^"]*"[^>]*>Ping</i);
  assertEquals(definition._handlerDefinitions.has("ping"), false);
});
