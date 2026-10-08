import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { runHandlerScript, tiny } from "../honoFactory.tsx";
import { Signals, Templates } from "../clientTools.ts";
import {
  bundleByFilename,
  type ClientFunctionImpl,
} from "../clientFunctions.ts";
import {
  ActivateParsedHandler,
  BuildFromTemplate,
  UpgradeCustomElement,
} from "../components/ActivateOnLoadHandler.tsx";
import type { HandlerProp } from "../eventAttributes.ts";
import { jsxTemplate } from "../jsx-runtime.ts";

/** The lifecycle tags a full page declares in its head, in order. */
function declaredInHead(html: string): string[] {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
  return [...head.matchAll(/<meta name="tt-define" content="([\w-]+)"\/>/g)]
    .map(([, tag]) => tag);
}

Deno.test("UpgradeCustomElement declares each custom tag once, ahead of the head script", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        <x-panel>One</x-panel>
        <x-panel>Two</x-panel>
        <y-panel>Three</y-panel>
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/")).text();
  assertEquals(declaredInHead(html), ["x-panel", "y-panel"]);
  // The declarations precede the inline runtime that defines them, and the
  // runtime precedes the body, so the elements upgrade as they are parsed.
  const metaAt = html.indexOf('<meta name="tt-define"');
  const scriptAt = html.indexOf("defineLifecycleTags();");
  const bodyAt = html.indexOf("<body>");
  assertEquals(metaAt < scriptAt && scriptAt < bodyAt, true);
  // Nothing is rendered beside the elements, and no define bundle is loaded.
  assertEquals(html.includes("modulepreload"), false);
  assertEquals(html.includes("?define="), false);
  assertStringIncludes(html, "<x-panel>One</x-panel><x-panel>Two</x-panel>");
});

Deno.test("the inline head script carries the lifecycle runtime", () => {
  assertStringIncludes(runHandlerScript, "function runHandler(");
  assertStringIncludes(runHandlerScript, "function defineLifecycleElement(");
  assertStringIncludes(runHandlerScript, "customElements.define(");
  assertStringIncludes(runHandlerScript, 'new Event("load")');
  assertStringIncludes(runHandlerScript, "this.abortController.abort()");
  // Declarations: the `<tt-define>` element and the head metas.
  assertStringIncludes(runHandlerScript, '"tt-define"');
  assertStringIncludes(runHandlerScript, 'meta[name="tt-define"]');
  assertStringIncludes(
    runHandlerScript,
    "const tiny = {runHandler, defineLifecycleElement};",
  );
});

Deno.test("partial updates declare tags at the top level, before the templates", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        <x-panel>One</x-panel>
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/", {
    headers: { "source-url": "http://localhost/previous" },
  })).text();
  assertMatch(
    html,
    /<update[^>]*><tt-define tag="x-panel"><\/tt-define><template/,
  );
  assertEquals(html.includes("tt-define") && !html.includes("<meta"), true);
});

Deno.test("UpgradeCustomElement recognises custom tags in precompiled markup", async () => {
  // What `"jsx": "precompile"` emits for `<x-panel>One</x-panel>` and for
  // `<section>{promise}</section>`: rendered markup, possibly a promise of it.
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        {jsxTemplate(strings("<x-panel>One</x-panel>"))}
        {jsxTemplate(
          strings("<x-panel>", "</x-panel>"),
          Promise.resolve("Two"),
        )}
        {jsxTemplate(strings("<section>Three</section>"))}
        {jsxTemplate(strings("<x-panel>Four</x-panel><x-panel>Five</x-panel>"))}
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/")).text();
  assertEquals(declaredInHead(html), ["x-panel", "upgrade-preceding"]);
  assertStringIncludes(html, "<x-panel>One</x-panel><x-panel>Two</x-panel>");
  // The plain element and the two-root markup still get a proxy sibling.
  assertEquals([...html.matchAll(/<upgrade-preceding /g)].length, 2);
  assertMatch(html, /<section>Three<\/section><upgrade-preceding /);
  assertMatch(html, /<x-panel>Five<\/x-panel><upgrade-preceding /);
});

Deno.test("UpgradeCustomElement gives plain tags a proxy sibling", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        <x-panel>One</x-panel>
        <section>Two</section>
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/")).text();
  // The proxy's own tag is declared like any other lifecycle tag.
  assertEquals(declaredInHead(html), ["x-panel", "upgrade-preceding"]);
  // Only the plain tag gets a proxy, which forwards load and suspend to it.
  assertMatch(
    html,
    /<section>Two<\/section><upgrade-preceding onload="tiny\.runHandler\(this,event\)" tt-handler-load="(\w+)\.forwardLoad" ondisconnect="tiny\.runHandler\(this,event\)" tt-handler-disconnect="\1\.forwardSuspend"><\/upgrade-preceding>/,
  );
  assertEquals([...html.matchAll(/<upgrade-preceding /g)].length, 1);
  assertEquals(html.includes("<link"), false);
});

Deno.test("template bundles define the lifecycle tags their markup upgrades", async () => {
  const rows = new Templates(import.meta.url, {
    row: () => (
      <UpgradeCustomElement>
        <x-row>Row</x-row>
      </UpgradeCustomElement>
    ),
  });
  await rows.ensureBuilt();
  const rendered = rows.rendered("row")!;
  assertEquals(rendered.lifecycleTags, ["x-row"]);
  assertEquals(rendered.handlerFiles, []);
  assertEquals(rendered.markup, "<x-row>Row</x-row>");
  const code = await rows._handlerDefinitions.get("row")!.bundle.buildCode();
  assertStringIncludes(code, 'tiny.defineLifecycleElement("x-row");');
  assertEquals(code.includes("import {"), false);

  // Rendering the template on the server declares the tag for the page.
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { template } = await tiny.imports(rows);
    return context.render(<div>{template.row()}</div>);
  });
  const html = await (await app.request("/")).text();
  assertEquals(declaredInHead(html), ["x-row"]);
  assertStringIncludes(html, "<div><x-row>Row</x-row></div>");
});

const parsedHandlers = new tiny.Handlers(import.meta.url, {
  build: function (this: HTMLElement) {
    this.dataset.built = "true";
  },
});

Deno.test("ActivateParsedHandler runs onParsed once through a trigger after the child", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { fn } = await tiny.imports(parsedHandlers);
    return context.render(
      <ActivateParsedHandler>
        <template onParsed={fn.build}>Content</template>
      </ActivateParsedHandler>,
    );
  });
  const html = await (await app.request("/")).text();
  // The element binds `parsed`; the link trigger after it fires on load and
  // preloads the bundle holding its own handler.
  assertMatch(
    html,
    /<template onparsed="tiny\.runHandler\(this,event\)" tt-handler-parsed="\w+\.build">Content<\/template><link rel="modulepreload" href="\/handlers\/(\w+)\.js" tt-handler-load="\1\.referParsed" onLoad="tiny\.runHandler\(this,event\)"\/>/,
  );
  // `parsed` is not a DOM event, so the trigger dispatches it via runHandler.
  const code = await bundleByFilename(
    /tt-handler-load="(\w+)\.referParsed"/.exec(html)![1],
  )!.buildCode();
  assertStringIncludes(code, 'tiny.runHandler(target, new Event("parsed"))');
  assertStringIncludes(code, "this.remove()");
});

Deno.test("BuildFromTemplate names a template clone and loads its bundle", async () => {
  const cards = new Templates(import.meta.url, {
    card: () => (
      <article>
        <slot name="title"></slot>
        <slot></slot>
      </article>
    ),
  });
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { template } = await tiny.imports(cards);
    return context.render(
      <BuildFromTemplate template={template.card}>
        <h2 slot="title">Hi</h2>
        <p>Body</p>
      </BuildFromTemplate>,
    );
  });
  const html = await (await app.request("/")).text();
  await cards.ensureBuilt();
  const bundle = cards._handlerDefinitions.get("card")!.filename;
  // The children wait inert in a template that names the clone; the trigger follows.
  assertMatch(
    html,
    new RegExp(
      `<template data-template="${bundle}\\.card" onparsed="tiny\\.runHandler\\(this,event\\)" tt-handler-parsed="\\w+\\.buildFromTemplate"><h2 slot="title">Hi</h2><p>Body</p></template><link rel="modulepreload"`,
    ),
  );
  // Reading the reference recorded the template bundle for the page.
  assertStringIncludes(
    html,
    `<script src="/handlers/${bundle}.js" type="module">`,
  );
  const { template } = await tiny.imports(cards);
  assertEquals(template.card.reference, `${bundle}.card`);
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
