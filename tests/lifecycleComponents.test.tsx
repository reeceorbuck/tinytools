import { assertEquals, assertMatch } from "@std/assert";
import { tiny } from "../honoFactory.tsx";
import { Signals } from "../clientTools.ts";
import type { ClientFunctionImpl } from "../clientFunctions.ts";
import { UpgradeCustomElement } from "../components/ActivateOnLoadHandler.tsx";
import type { HandlerProp } from "../eventAttributes.ts";

Deno.test("UpgradeCustomElement preloads the bundle holding its own handler", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        <x-panel>One</x-panel>
        <x-panel>Two</x-panel>
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/")).text();
  const links = [
    ...html.matchAll(
      /<link rel="modulepreload" href="\/handlers\/([\w]+)\.js"[^>]*tt-handler-load="(\w+)\.upgradePrecedingCustomElement"/g,
    ),
  ];
  assertEquals(links.length, 2);
  for (const [, preloaded, bundle] of links) {
    assertEquals(preloaded, bundle);
  }
});

Deno.test("UpgradeCustomElement names custom tags so they upgrade wherever they move", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        <x-panel>One</x-panel>
        <section>Two</section>
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/")).text();
  const defined = [...html.matchAll(/<link rel="modulepreload"[^>]*>/g)].map((
    [link],
  ) => /data-define="([^"]+)"/.exec(link)?.[1] ?? null);
  // Custom tags are defined by name; plain tags fall back to a proxy sibling.
  assertEquals(defined, ["x-panel", null]);
});

Deno.test("Signals collections share one runtime bundle", async () => {
  const first = new Signals(import.meta.url, ({ Signal }) => ({
    one: new Signal(1),
  }));
  const second = new Signals(import.meta.url, ({ Signal }) => ({
    two: new Signal(2),
  }));
  await Promise.all([first.ensureDefined(), second.ensureDefined()]);
  const runtimeOf = (
    collection: {
      _handlerDefinitions: ReadonlyMap<string, ClientFunctionImpl>;
    },
  ) =>
    [...collection._handlerDefinitions.values()][0].bundle.dependencies.get(
      "signalClasses",
    )!.bundle;
  assertEquals(runtimeOf(first), runtimeOf(second));
  assertEquals(
    runtimeOf(first).sourceFileUrl?.endsWith("signals.ts"),
    true,
  );
});

Deno.test("layouts may return their children unchanged", async () => {
  const app = new tiny.Hono({ tools: "core" }).use(
    tiny.middleware.partialLayout(({ children }, context) =>
      context.req.header("source-url") ? children : <main>{children}</main>
    ),
  );
  app.get("/", (context) => context.render(<p>Content</p>));
  const full = await (await app.request("/")).text();
  assertMatch(full, /<main><p>Content<\/p><\/main>/);
  const partial = await (await app.request("/", {
    headers: { "source-url": "http://localhost/previous" },
  })).text();
  assertEquals(partial.includes("<main>"), false);
  assertMatch(partial, /<p>Content<\/p>/);
});

const trialHandlers = new tiny.Handlers(import.meta.url, {
  mount: function (this: HTMLElement) {
    this.dataset.mounted = "true";
  },
  keyboard: function (this: HTMLElement, _event: KeyboardEvent) {},
});

/** A component forwarding an imported reference to an element. */
function Panel(props: { onLoad?: HandlerProp<(this: HTMLElement) => void> }) {
  return <section onLoad={props.onLoad} />;
}

Deno.test("HandlerProp accepts imported references and forwards them", async () => {
  const { fn } = await tiny.imports(trialHandlers);
  const html = String(<Panel onLoad={fn.mount} />);
  assertMatch(html, /tt-handler-load="\w+\.mount"/);
  // @ts-expect-error A keyboard handler does not satisfy a load handler.
  void <Panel onLoad={fn.keyboard} />;
  // @ts-expect-error Raw functions are not handler references.
  void <Panel onLoad={function () {}} />;
});
