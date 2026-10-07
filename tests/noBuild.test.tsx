import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fileURLToPath } from "node:url";

if (!Deno.args.includes("--none")) {
  Deno.test("none mode serves generated assets with writes denied", async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--no-lock",
        "--allow-env",
        "--allow-read",
        "--allow-run",
        "--deny-write",
        fileURLToPath(import.meta.url),
        "--",
        "--none",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      result.code,
      0,
      new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    );
    assertEquals(
      new TextDecoder().decode(result.stderr).includes("[tiny-tools] failed"),
      false,
    );
  });
} else {
  const { tiny } = await import("../honoFactory.tsx");
  const { cache, memoryAssets, memoryBuild } = await import(
    "../clientTools.ts"
  );
  const { getEsbuild } = await import("../esbuildInit.ts");
  const { UpgradeCustomElement } = await import(
    "../components/ActivateOnLoadHandler.tsx"
  );

  Deno.test({
    name:
      "memory assets include dependencies and styles without package client scripts",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      assertEquals(memoryBuild, true);
      assertEquals(cache.trustCache, false);
      const dependencies = new tiny.Handlers(import.meta.url, {
        increment(value: number) {
          return value + 1;
        },
      });
      const handlers = new tiny.Handlers(import.meta.url, async () => {
        const { fn } = await tiny.imports(dependencies);
        return {
          click(this: HTMLButtonElement) {
            this.textContent = String(fn.increment(41));
          },
        };
      });
      const styles = new tiny.Styles(import.meta.url, {
        button: "color: red;",
      });
      const unused = new tiny.Handlers(import.meta.url, {
        unused() {
          return "not requested";
        },
      });
      const app = new tiny.Hono({
        tools: "core",
        serveStatic: () => async (_context, next) => await next(),
      });
      app.get("/", async (context) => {
        const { fn, styled } = await tiny.imports(handlers, styles);
        return context.render(
          <>
            <button type="button" class={styled.button} onClick={fn.click}>
              Run
            </button>
            <UpgradeCustomElement>
              <store-test-output />
            </UpgradeCustomElement>
          </>,
        );
      });
      try {
        const pages = await Promise.all(
          Array.from({ length: 3 }, async () => {
            const response = await app.request("/");
            assertEquals(response.status, 200);
            return await response.text();
          }),
        );
        const html = pages[0];
        assertStringIncludes(html, "<button");
        // The custom tag is declared in the head for the inline runtime to define.
        assertStringIncludes(
          html,
          '<meta name="tt-define" content="store-test-output"/>',
        );
        const filename = handlers._handlerFilenames.get("click")!;
        const dependencyFilename = dependencies._handlerFilenames.get(
          "increment",
        )!;
        assertStringIncludes(html, filename);
        const script = await app.request(`/handlers/${filename}.js`);
        assertEquals(script.status, 200);
        assertStringIncludes(
          script.headers.get("content-type")!,
          "application/javascript",
        );
        assertStringIncludes(script.headers.get("cache-control")!, "immutable");
        assertStringIncludes(await script.text(), `./${dependencyFilename}.js`);
        const dependency = await app.request(
          `/handlers/${dependencyFilename}.js`,
        );
        assertEquals(dependency.status, 200);
        const compiled = await import(
          `data:text/javascript,${encodeURIComponent(await dependency.text())}`
        );
        assertEquals(compiled.increment(41), 42);
        const stylePath = html.match(/href="(\/styles\/[^"]+\.css)"/)?.[1];
        assertEquals(typeof stylePath, "string");
        const stylesheet = await app.request(stylePath!);
        assertEquals(stylesheet.status, 200);
        assertStringIncludes(
          stylesheet.headers.get("content-type")!,
          "text/css",
        );
        assertStringIncludes(await stylesheet.text(), "color: red");
        assertEquals(html.includes("/_tinytools/"), false);
        assertStringIncludes(html, tiny.runHandler.toString());
        assertStringIncludes(
          html,
          "const tiny = {runHandler, defineLifecycleElement};",
        );
        assertEquals(
          memoryAssets.has(
            `/handlers/${unused._handlerFilenames.get("unused")}.js`,
          ),
          false,
        );
        for (const path of ["/handlers/missing.js", "/styles/missing.css"]) {
          const missing = await app.request(path);
          assertEquals(missing.status, 404);
          await missing.text();
        }
        const assetsBefore = new Map(memoryAssets);
        const again = await app.request("/");
        await again.text();
        assertEquals(memoryAssets, assetsBefore);
        cache.save();
        await assertRejects(
          () => tiny.build(),
          Error,
          "Full builds are disabled",
        );
      } finally {
        (await getEsbuild()).stop();
      }
    },
  });
}
