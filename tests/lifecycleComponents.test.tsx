import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { runHandlerScript, runtimeScriptPath, tiny } from "../honoFactory.tsx";
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
import { jsxAttr, jsxTemplate } from "../jsx-runtime.ts";
import {
  lifecycleFallbackPath,
  lifecycleRuntimeFiles,
  lifecycleRuntimePath,
  lifecycleRuntimeScript,
} from "../lifecycleElement.ts";
import { parseHTML } from "linkedom";

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
  // The declarations precede the runtime that defines them, and the runtime
  // precedes the body, so the elements upgrade as they are parsed.
  const metaAt = html.indexOf('<meta name="tt-define"');
  const scriptAt = html.indexOf(`<script src="${runtimeScriptPath()}">`);
  const lifecycleAt = html.indexOf(
    `<script>${lifecycleRuntimeScript}</script>`,
  );
  const bodyAt = html.indexOf("<body>");
  assertEquals(metaAt < scriptAt && scriptAt < lifecycleAt, true);
  assertEquals(lifecycleAt < bodyAt, true);
  // Nothing is rendered beside the elements, and no define bundle is loaded.
  assertEquals(html.includes("modulepreload"), false);
  assertEquals(html.includes("?define="), false);
  assertStringIncludes(html, "<x-panel>One</x-panel><x-panel>Two</x-panel>");
});

Deno.test("the core head script is just the dispatcher; the lifecycle runtime is separate", () => {
  assertStringIncludes(runHandlerScript, "function runHandler(");
  assertStringIncludes(runHandlerScript, "const tiny = {runHandler};");
  assertEquals(runHandlerScript.includes("customElements"), false);
  // Inlined source is compacted: no comment lines, no indentation.
  assertEquals(/^\s|^\/\//m.test(runHandlerScript), false);
  assertEquals(/^\s|^\/\//m.test(lifecycleRuntimeScript), false);
  // Both parse as classic scripts.
  new Function(runHandlerScript);
  new Function(lifecycleRuntimeScript);

  assertStringIncludes(
    lifecycleRuntimeScript,
    "tiny.defineLifecycleElement || (() => {",
  );
  assertStringIncludes(
    lifecycleRuntimeScript,
    "function defineLifecycleElement(",
  );
  assertStringIncludes(lifecycleRuntimeScript, 'new Event("connect")');
  assertStringIncludes(lifecycleRuntimeScript, "abortController?.abort()");
  assertStringIncludes(lifecycleRuntimeScript, '"tt-define"');
  assertStringIncludes(lifecycleRuntimeScript, 'meta[name="tt-define"]');
  // Customized built-ins, with the observer fallback imported only where
  // the browser has none.
  assertStringIncludes(
    lifecycleRuntimeScript,
    "function supportsCustomizedBuiltins(",
  );
  assertStringIncludes(
    lifecycleRuntimeScript,
    `const lifecycleState = {fallback: "${lifecycleFallbackPath}"};`,
  );
  assertStringIncludes(
    lifecycleRuntimeScript,
    "import(lifecycleState.fallback)",
  );
  assertEquals(lifecycleRuntimeScript.includes("MutationObserver"), false);
  assertStringIncludes(
    lifecycleRuntimeFiles.get(lifecycleFallbackPath)!,
    "new MutationObserver(",
  );
});

Deno.test("only pages using lifecycle tags carry the lifecycle runtime", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/plain", (context) => context.render(<div>Plain</div>));
  app.get("/upgraded", (context) =>
    context.render(
      <UpgradeCustomElement>
        <x-panel>One</x-panel>
      </UpgradeCustomElement>,
    ));
  const plain = await (await app.request("/plain")).text();
  assertEquals(plain.includes(lifecycleRuntimeScript), false);
  const upgraded = await (await app.request("/upgraded")).text();
  const coreAt = upgraded.indexOf(
    `<script src="${runtimeScriptPath()}"></script>`,
  );
  const runtimeAt = upgraded.indexOf(
    `<script>${lifecycleRuntimeScript}</script>`,
  );
  assertEquals(0 < coreAt && coreAt < runtimeAt, true);
  assertEquals(runtimeAt < upgraded.indexOf("<body>"), true);
});

Deno.test("core middleware serves the lifecycle modules as immutable files", async () => {
  const app = new tiny.Hono({ tools: "core" });
  for (const [path, source] of lifecycleRuntimeFiles) {
    assertMatch(path, /^\/tt-lifecycle(-fallback)?_[0-9a-f]{8}\.js$/);
    const response = await app.request(path);
    assertEquals(response.status, 200);
    assertStringIncludes(
      response.headers.get("content-type")!,
      "application/javascript",
    );
    assertStringIncludes(response.headers.get("cache-control")!, "immutable");
    assertEquals(await response.text(), source);
  }
  assertEquals(lifecycleRuntimeFiles.has(lifecycleRuntimePath), true);
});

Deno.test("the observer fallback connects and disconnects elements carrying a declared is", async () => {
  const { document, HTMLElement, MutationObserver } = parseHTML(
    '<html><body><button is="x-button">One</button><button>Plain</button></body></html>',
  );
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { document, HTMLElement, MutationObserver });
  try {
    const { observeBuiltinFallback } = await import(
      `data:text/javascript,${
        encodeURIComponent(lifecycleRuntimeFiles.get(lifecycleFallbackPath)!)
      }`
    );
    const events: string[] = [];
    const connect = (element: Element) =>
      events.push(`connect ${element.textContent}`);
    const disconnect = (element: Element) =>
      events.push(`disconnect ${element.textContent}`);
    observeBuiltinFallback("x-button", connect, disconnect);
    // Declaring a name again is a no-op.
    observeBuiltinFallback("x-button", connect, disconnect);
    assertEquals(events, ["connect One"]);

    const wrapper = document.createElement("div");
    wrapper.innerHTML =
      '<button is="x-button">Two</button><button>Plain</button>';
    document.body.append(wrapper);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(events, ["connect One", "connect Two"]);

    wrapper.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(events, ["connect One", "connect Two", "disconnect Two"]);
  } finally {
    for (const name of ["document", "HTMLElement", "MutationObserver"]) {
      delete globals[name];
    }
  }
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
  // The page may not have the lifecycle runtime yet, so it comes first.
  assertStringIncludes(
    html,
    `<script>${lifecycleRuntimeScript}</script><tt-define tag="x-panel"></tt-define><template`,
  );
  assertMatch(html, /^(<!DOCTYPE html>)?<update[^>]*><script>/);
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
  // Only the plain tag gets a proxy, which forwards connect and disconnect to it.
  assertMatch(
    html,
    /<section>Two<\/section><upgrade-preceding onconnect="tiny\.runHandler\(this,event\)" tt-handler-connect="(\w+)\.forwardConnect" ondisconnect="tiny\.runHandler\(this,event\)" tt-handler-disconnect="\1\.forwardDisconnect"><\/upgrade-preceding>/,
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
  // A page without the runtime gets it before the tag is defined.
  assertStringIncludes(code, `"${lifecycleRuntimePath}"`);
  assertMatch(code, /await import\(\w+\)/);
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
function Panel(
  props: { onConnect?: HandlerProp<(this: HTMLElement) => void> },
) {
  return <section is="live-section" onConnect={props.onConnect} />;
}

Deno.test("HandlerProp accepts imported references and forwards them", async () => {
  const { fn } = await tiny.imports(trialHandlers);
  const html = String(<Panel onConnect={fn.mount} />);
  assertMatch(html, /tt-handler-connect="\w+\.mount"/);
  // @ts-expect-error A keyboard handler does not satisfy a load handler.
  void <Panel onConnect={fn.keyboard} />;
  // @ts-expect-error Raw functions are not handler references.
  void <Panel onConnect={function () {}} />;
});

Deno.test("a custom tag binding a lifecycle handler declares itself without a wrapper", async () => {
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { fn } = await tiny.imports(parsedHandlers);
    return context.render(
      <div>
        <x-panel onConnect={fn.build}>One</x-panel>
        <y-panel onDisconnect={fn.build}>Two</y-panel>
      </div>,
    );
  });
  const html = await (await app.request("/")).text();
  assertEquals(declaredInHead(html), ["x-panel", "y-panel"]);
  assertEquals(html.includes("upgrade-preceding"), false);
});

Deno.test("precompiled markup binding a lifecycle handler declares its custom tag", async () => {
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { fn } = await tiny.imports(parsedHandlers);
    // `<section><x-panel onConnect={fn.build}>One</x-panel></section>`
    return context.render(
      jsxTemplate(
        strings("<section><x-panel ", ">One</x-panel></section>"),
        jsxAttr("onConnect", fn.build),
      ),
    );
  });
  const html = await (await app.request("/")).text();
  assertEquals(declaredInHead(html), ["x-panel"]);
  assertMatch(
    html,
    /<section><x-panel onconnect="[^"]+" tt-handler-connect="\w+\.build">One<\/x-panel><\/section>/,
  );
});

Deno.test("a plain tag binding onConnect without the wrapper throws", async () => {
  const { fn } = await tiny.imports(parsedHandlers);
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const forgotten =
    /<input> binds onConnect but nothing fires it.*UpgradeCustomElement/;
  // Nested directly in an element, in a fragment, or in a list of children.
  assertThrows(
    () => (
      <div>
        <input onConnect={fn.build} />
      </div>
    ),
    TypeError,
    undefined,
    "nested",
  );
  assertMatch(
    (assertThrows(() => (
      <div>
        <input onConnect={fn.build} />
      </div>
    )) as Error).message,
    forgotten,
  );
  const group = (
    <>
      <span>Label</span>
      <input onConnect={fn.build} />
    </>
  );
  assertThrows(() => <div>{group}</div>, TypeError);
  assertThrows(
    () => (
      <div>{["a"].map((key) => <input key={key} onConnect={fn.build} />)}</div>
    ),
    TypeError,
  );
  // Precompiled: nested in the same markup, or a top-level element placed
  // as a child of other markup.
  assertThrows(
    () =>
      jsxTemplate(
        strings("<div><input ", "></div>"),
        jsxAttr("onConnect", fn.build),
      ),
    TypeError,
  );
  assertThrows(
    () =>
      jsxTemplate(
        strings("<div>", "</div>"),
        jsxTemplate(strings("<input ", ">"), jsxAttr("onConnect", fn.build)),
      ),
    TypeError,
  );
  // Tags with a native load event are left alone.
  void (
    <div>
      <img src="/a.png" onLoad={fn.build} />
    </div>
  );
});

Deno.test("a plain tag binding onConnect inside the wrapper renders with its proxy", async () => {
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { fn } = await tiny.imports(parsedHandlers);
    return context.render(
      <div>
        <UpgradeCustomElement>
          <input onConnect={fn.build} />
        </UpgradeCustomElement>
        <UpgradeCustomElement>
          {jsxTemplate(
            strings("<textarea ", "></textarea>"),
            jsxAttr("onConnect", fn.build),
          )}
        </UpgradeCustomElement>
      </div>,
    );
  });
  const html = await (await app.request("/")).text();
  assertEquals(declaredInHead(html), ["upgrade-preceding"]);
  assertMatch(
    html,
    /<input onconnect="[^"]+" tt-handler-connect="\w+\.build"\/><upgrade-preceding /,
  );
  assertMatch(
    html,
    /<textarea onconnect="[^"]+" tt-handler-connect="\w+\.build"><\/textarea><upgrade-preceding /,
  );
});

Deno.test("an is attribute makes a plain tag a customized built-in lifecycle element", async () => {
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", async (context) => {
    const { fn } = await tiny.imports(parsedHandlers);
    const kind = "bound-select";
    return context.render(
      <div>
        <button
          type="button"
          is="custom-button"
          onConnect={fn.build}
          onDisconnect={fn.build}
        >
          Go
        </button>
        <input is="bound-input" onConnect={fn.build} />
        <UpgradeCustomElement>
          <textarea is="bound-text" onConnect={fn.build}></textarea>
        </UpgradeCustomElement>
        {/* Precompiled: `is` before the handler, after it, and bound dynamically. */}
        {jsxTemplate(
          strings('<p is="bound-p" ', "></p>"),
          jsxAttr("onConnect", fn.build),
        )}
        {jsxTemplate(
          strings("<section ", ' is="bound-section"></section>'),
          jsxAttr("onConnect", fn.build),
        )}
        {jsxTemplate(
          strings("<select ", " ", "></select>"),
          jsxAttr("is", kind),
          jsxAttr("onConnect", fn.build),
        )}
      </div>,
    );
  });
  const html = await (await app.request("/")).text();
  assertEquals(
    [...html.matchAll(/<meta name="tt-define" content="([\w:-]+)"\/>/g)]
      .map(([, tag]) => tag),
    [
      "custom-button:button",
      "bound-input:input",
      "bound-text:textarea",
      "bound-p:p",
      "bound-section:section",
      "bound-select:select",
    ],
  );
  // Nothing is rendered beside them, not even by the wrapper.
  assertEquals(html.includes("upgrade-preceding"), false);
  assertMatch(
    html,
    /<button type="button" is="custom-button" onconnect="[^"]+" tt-handler-connect="\w+\.build"/,
  );
  // Without a hyphen, `is` does not make a custom element.
  const { fn } = await tiny.imports(parsedHandlers);
  assertThrows(
    () => (
      <div>
        <input is="plain" onConnect={fn.build} />
      </div>
    ),
    TypeError,
    'is="..."',
  );
});

Deno.test("a fragment-only template keeps a proxied element wrappable", async () => {
  // What a component such as `labelled(undefined, control)` returns under
  // `"jsx": "precompile"`: `<>{control}</>`, with no element of its own.
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const { fn } = await tiny.imports(parsedHandlers);
  const control = () =>
    jsxTemplate(
      strings("<select ", "></select>"),
      jsxAttr("onConnect", fn.build),
    );
  const fragment = jsxTemplate(strings("", ""), control());
  // Placed inside an element the handler would never fire.
  assertThrows(
    () => jsxTemplate(strings("<label>", "</label>"), fragment),
    TypeError,
    "<select> binds onConnect",
  );
  // Handed to the wrapper, it gets its proxy like any plain element.
  const app = new tiny.Hono({ tools: "core" });
  app.get("/", (context) =>
    context.render(
      <UpgradeCustomElement>
        {jsxTemplate(strings("", ""), control())}
      </UpgradeCustomElement>,
    ));
  const html = await (await app.request("/")).text();
  assertMatch(
    html,
    /<select onconnect="[^"]+" tt-handler-connect="\w+\.build"><\/select><upgrade-preceding /,
  );
});

Deno.test("onLoad is rejected wherever nothing fires load", async () => {
  const { fn } = await tiny.imports(parsedHandlers);
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  // A lifecycle element runs connect instead.
  assertThrows(() => <x-panel onLoad={fn.build} />, TypeError, "onConnect");
  assertThrows(
    () => <input is="bound-input" onLoad={fn.build} />,
    TypeError,
    "never fires load",
  );
  assertThrows(
    () =>
      jsxTemplate(
        strings("<x-panel ", "></x-panel>"),
        jsxAttr("onLoad", fn.build),
      ),
    TypeError,
    "never fires load",
  );
  // A bare element placed anywhere; the wrapper rejects it too.
  assertThrows(
    () => (
      <div>
        <p onLoad={fn.build} />
      </div>
    ),
    TypeError,
    "Bind onConnect",
  );
  await assertRejects(
    () => UpgradeCustomElement({ children: <p onLoad={fn.build} /> }),
    TypeError,
    "<p> binds onLoad",
  );
  // The elements the browser fires load on keep it, body included.
  void <body onLoad={fn.build} />;
  void (
    <div>
      <img src="/a.png" onLoad={fn.build} />
    </div>
  );
});
