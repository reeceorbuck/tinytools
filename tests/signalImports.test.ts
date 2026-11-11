import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, useContext } from "hono/jsx";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Constants,
  createNoContextToolUsageTracker,
  Handlers,
  imports,
  registeredClientTools,
  SignalComponent,
  Signals,
  withNoContextToolUsageTracker,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import {
  Fragment,
  type JSX,
  jsx,
  jsxAttr,
  jsxTemplate,
} from "../jsx-runtime.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import type { Signal, SignalTools, SignalValue } from "../signals.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

const defaults = new Constants<{ shade: string; tolerance: number }>({
  shade: "B1",
  tolerance: 3,
});

function createHelpers() {
  return new Handlers(import.meta.url, {
    signalsFrom<Values extends Record<string, SignalValue>>(
      Signal: SignalTools["Signal"],
      initialValues: Values,
    ): { [Key in keyof Values]: Signal<Values[Key]> } {
      return Object.fromEntries(
        Object.entries(initialValues).map((
          [key, value],
        ) => [key, new Signal(value)]),
      ) as { [Key in keyof Values]: Signal<Values[Key]> };
    },
    unused() {
      return "unused";
    },
  });
}

/**
 * Outside the test body: a local `fn` there would clash with the test's own
 * `fn` method and be renamed by the transpiler.
 */
function createCollection(helpers: ReturnType<typeof createHelpers>) {
  return new Signals(import.meta.url, async () => {
    const { fn, constants } = await imports(helpers, defaults);
    return ({ Signal, Computed }) => {
      const { shade, tolerance } = fn.signalsFrom(Signal, constants);
      const label = new Computed(() => `${shade.value} ${tolerance.value}`);
      return { shade, tolerance, label };
    };
  });
}

Deno.test({
  name: "an async Signals definition imports handlers for server and browser",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-imports";
    const helpers = createHelpers();
    const collection = createCollection(helpers);
    const checkTypes = async () => {
      const values = await collection.evaluateUsingInitialValues();
      // @ts-expect-error tolerance is typed from the default
      const tolerance: string = values.tolerance;
      void tolerance;
    };
    void checkTypes;
    try {
      assertEquals(await collection.evaluateUsingInitialValues(), {
        shade: "B1",
        tolerance: 3,
        label: "B1 3",
      });
      assertEquals(
        (await collection.evaluateUsingInitialValues({ shade: "A2" })).label,
        "A2 3",
      );

      await buildScriptFiles({ fresh: true, publicDir: directory });
      const filename = collection._handlerFilenames.get("shade")!;
      const path = `${Deno.cwd()}/${directory}/handlers/${filename}.js`;
      const code = await Deno.readTextFile(path);
      assertStringIncludes(
        code,
        `from "./${helpers._handlerFilenames.get("signalsFrom")}.js"`,
      );
      assertEquals(code.includes("unused"), false);
      const module = await import(pathToFileURL(path).href);
      assertEquals(module.shade.value, "B1");
      assertEquals(module.label.value, "B1 3");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("Signals definitions reject captures, signal imports and non-factories", async () => {
  reset();
  try {
    const helpers = createHelpers();
    const local = { shade: "A1" };
    const capturing = new Signals(import.meta.url, async () => {
      await imports(helpers);
      return ({ Signal }) => ({ shade: new Signal<string>(local.shade) });
    });
    await assertRejects(
      () => capturing.ensureDefined(),
      TypeError,
      "references 'local'",
    );

    const other = new Signals(import.meta.url, ({ Signal }) => ({
      count: new Signal(1),
    }));
    const importingSignals = new Signals(import.meta.url, async () => {
      await imports(other);
      return ({ Signal }) => ({ shade: new Signal("B1") });
    });
    await assertRejects(
      () => importingSignals.ensureDefined(),
      TypeError,
      "can import handlers only",
    );

    const notAFactory = new Signals(
      // @ts-expect-error the definition must resolve to a factory
      import.meta.url,
      async () => {
        await imports(helpers);
        return { shade: 1 };
      },
    );
    await assertRejects(
      () => notAFactory.ensureDefined(),
      TypeError,
      "must resolve to a synchronous factory",
    );
  } finally {
    reset();
  }
});

Deno.test({
  name: "a signal name defined by two imported collections is ambiguous",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-ambiguous";
    const images = new Signals(import.meta.url, ({ Signal }) => ({
      opens: new Signal(0),
      imageSrc: new Signal(""),
    }));
    const attachments = new Signals(import.meta.url, ({ Signal }) => ({
      opens: new Signal(0),
      href: new Signal(""),
    }));
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { signal } = await imports(images, attachments);
      // Names only one collection defines still resolve.
      assertExists(signal.imageSrc);
      assertThrows(() => signal.opens, Error, "Ambiguous signal 'opens'");
      // Imported separately, each collection's `opens` is unambiguous.
      assertExists((await imports(images)).signal.opens);
      assertExists((await imports(attachments)).signal.opens);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "an imported component's instance() renders it and binds its signals by tt-link",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-component-instance";
    const boxSignals = new Signals(
      import.meta.url,
      ({ Trigger, Scope }) =>
        new Scope(() => ({ press: new Trigger(), internal: new Trigger() })),
    );
    const strings = (...parts: string[]) =>
      Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
    const Box = (
      props: { label: string; precompiled?: boolean; own?: boolean },
    ) =>
      props.precompiled
        ? jsxTemplate(
          strings(props.own ? '<output class="own">' : "<output>", "</output>"),
          props.label,
        )
        : jsx("output", {
          class: props.own ? "own" : undefined,
          children: props.label,
        });
    const BoxComponent = new SignalComponent(async () => {
      const { signal } = await imports(boxSignals);
      return { signal: [signal.press], Box };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { component, signal, fn } = await imports(BoxComponent, boxSignals);
      const one = component.Box.instance();
      const two = component.Box.instance();
      assertEquals(one.name, "Box");
      const linkOf = (html: string) => /tt-link="([^"]+)"/.exec(html)?.[1];
      const oneLink = linkOf(String(await one({ label: "b" })))!;
      assertEquals(oneLink.startsWith(`${boxSignals.instanceKey}=link-`), true);
      assertEquals(
        linkOf(String(await two({ label: "b" }))) === oneLink,
        false,
      );
      // An instance links its root into that instance, with no id to
      // repeat, in both JSX modes.
      for (const precompiled of [false, true]) {
        assertEquals(
          String(await one({ label: "b", precompiled })),
          `<output data-tc="Box" tt-link="${oneLink}">b</output>`,
        );
        // A class joins the root's own, each class once, and the component
        // never sees it.
        for (const own of [false, true]) {
          const html = String(
            await one({ label: "b", precompiled, own, class: "wide own" }),
          );
          assertEquals(
            html.match(/ class="[^"]*"/g),
            [own ? ' class="own wide"' : ' class="wide own"'],
          );
        }
      }

      const clean = (html: string) =>
        html.replace(/(\w+)_[0-9a-f]{5}\./g, "$1.");
      // An instance's reference links the element using it into the
      // instance, as its root is.
      assertStringIncludes(
        clean(
          String(jsx("button", { onClick: fn.signals.fire(one.signal.press) })),
        ),
        `tt-handler-click="signals.fire(signalImports_test.press)" tt-link="${oneLink}"`,
      );
      // Precompiled attributes render the same.
      assertStringIncludes(
        clean(String(jsxAttr("onClick", fn.signals.fire(two.signal.press)))),
        `tt-link="${linkOf(String(await two({ label: "b" })))}"`,
      );
      // So does live text.
      assertStringIncludes(
        String(jsx("output", { children: one.signal.press })),
        `tt-link="${oneLink}"`,
      );
      // References from tiny.imports() still resolve by ancestry.
      assertEquals(
        String(jsx("button", { onClick: fn.signals.fire(signal.press) }))
          .includes("tt-link"),
        false,
      );
      assertThrows(
        () =>
          jsx("button", {
            onClick: [
              fn.signals.fire(one.signal.press),
              fn.signals.fire(two.signal.press),
            ],
          }),
        TypeError,
        "one instance only",
      );
      // Only the signals the factory exposes reach an instance, typed.
      // @ts-expect-error `internal` is not exposed
      assertEquals(one.signal.internal, undefined);
      await assertRejects(
        () =>
          imports(
            // deno-lint-ignore no-explicit-any
            new SignalComponent(() => ({ signal: [{} as any], Box })),
          ),
        TypeError,
        "lists signals from a tiny.imports()",
      );
      // The list is a list, even of one.
      await assertRejects(
        async () => {
          const { signal } = await imports(boxSignals);
          await imports(
            // @ts-expect-error `signal` is a list of references
            new SignalComponent(() => ({ signal: signal.press, Box })),
          );
        },
        TypeError,
        "lists signals from a tiny.imports()",
      );
      // With an enclosing level, an instance's root carries only its own
      // level, and the page encloses instances in a root of `scopeKey`.
      const nested = new Signals(
        import.meta.url,
        ({ Trigger, Scope }) =>
          new Scope(() => ({
            recolor: new Trigger(),
            box: new Scope(() => ({ press: new Trigger() })),
          })),
      );
      await nested.ensureBuilt();
      const { component: grouped } = await imports(
        new SignalComponent(async () => {
          const { signal } = await imports(nested);
          return { signal: [signal.press, signal.recolor], Box };
        }),
      );
      assertEquals(grouped.Box.scopeKey, nested.instanceKey);
      const inGroup = grouped.Box.instance();
      const inGroupLink = linkOf(String(await inGroup({ label: "c" })))!;
      assertEquals(
        inGroupLink.startsWith(`${nested.scopes.box.key}=link-`),
        true,
      );
      // The outer level is the enclosing element's, for its references too.
      assertStringIncludes(
        String(
          jsx("button", { onClick: fn.signals.fire(inGroup.signal.recolor) }),
        ),
        `tt-link="${inGroupLink}"`,
      );
      // Without an instance, exposed signals resolve by ancestry.
      assertEquals(
        String(
          jsx("button", { onClick: fn.signals.fire(grouped.signal.recolor) }),
        )
          .includes("tt-link"),
        false,
      );
      assertEquals(component.Box.scopeKey, "");
      // component.instance() makes one copy: an instance of each component,
      // sharing every level. Copies made together by `repeat` share the
      // enclosing level and each keep their own innermost one.
      const link = /tt-link="([^"]+)"/;
      const linksOf = async (instance: typeof Box) =>
        Object.fromEntries(
          (link.exec(String(await instance({ label: "d" })))?.[1] ??
            "").split(" ").map((token) => token.split("=")),
        );
      const outer = nested.instanceKey;
      const inner = nested.scopes.box.key;
      const alone = await linksOf(grouped.instance().Box);
      assertEquals(Object.keys(alone).sort(), [outer, inner].sort());
      const copies = grouped.instance(2);
      assertEquals(copies.length, 2);
      const [first, second] = [
        await linksOf(copies[0].Box),
        await linksOf(copies[1].Box),
      ];
      assertEquals(first[outer], second[outer]);
      assertEquals(first[inner] === second[inner], false);
      assertEquals(first[outer] === alone[outer], false);
      // A single component's instance() links only its own level.
      assertEquals(
        Object.keys(await linksOf(grouped.Box.instance())),
        [inner],
      );
      assertThrows(() => grouped.instance(1.5), TypeError, "whole number");
      // A named copy is the same copy wherever it is made.
      assertEquals(
        await linksOf(grouped.instance("recalls").Box),
        await linksOf(grouped.instance("recalls").Box),
      );
      assertEquals(
        (await linksOf(grouped.instance("recalls").Box))[inner] ===
          (await linksOf(grouped.instance("bookings").Box))[inner],
        false,
      );
      assertThrows(() => grouped.instance("two words"), TypeError, "its id");
      // With a single level, a copy's parts share it: its roots carry the
      // link alone.
      const single = String(
        await component.instance().Box({ label: "g" }),
      );
      assertStringIncludes(
        single,
        `tt-link="${boxSignals.instanceKey}=link-`,
      );
      assertEquals(single.includes("tt-instance"), false);
      await assertRejects(
        () =>
          imports(
            new SignalComponent(() => ({ instance: Box })),
          ),
        TypeError,
        "can't name a component 'instance'",
      );

      // A factory may return several components; each has its own instances,
      // and every one exposes the factory's signals.
      const { component: pair } = await imports(
        new SignalComponent(async () => {
          const { signal } = await imports(boxSignals);
          return { signal: [signal.press], Box, Other: Box };
        }),
      );
      assertEquals(pair.Box.instance().name, "Box");
      const other = pair.Other.instance();
      assertStringIncludes(
        String(jsx("button", { onClick: fn.signals.fire(other.signal.press) })),
        `tt-link="${linkOf(String(await other({ label: "o" })))}"`,
      );
      // A copy's signals act on the copy, whose parts carry none of their own.
      const copy = pair.instance();
      const copyLink = linkOf(String(await copy.Box({ label: "p" })));
      assertEquals(linkOf(String(await copy.Other({ label: "q" }))), copyLink);
      assertStringIncludes(
        String(jsx("button", { onClick: fn.signals.fire(copy.signal.press) })),
        `tt-link="${copyLink}"`,
      );
      // @ts-expect-error a copy's parts carry no signals
      assertEquals(copy.Box.signal, undefined);
      // @ts-expect-error `internal` is not exposed
      assertEquals(copy.signal.internal, undefined);
      // Without a copy, the component's signals resolve by ancestry.
      assertEquals(
        String(jsx("button", { onClick: fn.signals.fire(pair.signal.press) }))
          .includes("tt-link"),
        false,
      );
      // A name two components imported together both expose has no one
      // copy to act on, so reading it throws; their other parts still work.
      const { component: both } = await imports(
        BoxComponent,
        new SignalComponent(async () => {
          const { signal } = await imports(boxSignals);
          return { signal: [signal.press], Second: Box };
        }),
      );
      const bothCopy = both.instance();
      assertThrows(() => bothCopy.signal.press, TypeError, "both expose");
      assertThrows(() => both.signal.press, TypeError, "both expose");
      assertStringIncludes(
        String(await bothCopy.Second({ label: "r" })),
        ">r<",
      );
      // A plain function is a component that exposes no signals.
      const { component: plain } = await imports(
        new SignalComponent(() => ({ Box })),
      );
      const plainBox = plain.instance().Box;
      // No component's root has an id to repeat.
      const plainHtml = String(await plainBox({ label: "h" }));
      assertStringIncludes(plainHtml, ">h</output>");
      assertEquals(plainHtml.includes(" id="), false);
      // @ts-expect-error a factory without a list exposes no signals
      assertEquals(plain.instance().signal.press, undefined);
      // So is markup, rendered as it is, in both JSX modes.
      const { component: markup } = await imports(
        new SignalComponent(async () => {
          const { signal } = await imports(boxSignals);
          return {
            signal: [signal.press],
            Plain: jsx("output", { children: "i" }) as unknown as JSX.Element,
            Precompiled: jsxTemplate(strings("<output>i</output>")),
          };
        }),
      );
      const fromMarkup = markup.instance();
      for (const made of [fromMarkup.Plain, fromMarkup.Precompiled]) {
        const html = String(await made({}));
        assertEquals(html.includes(" id="), false);
        assertStringIncludes(html, ">i</output>");
      }
      assertStringIncludes(
        String(
          jsx("button", { onClick: fn.signals.fire(fromMarkup.signal.press) }),
        ),
        `tt-link="${linkOf(String(await fromMarkup.Plain({})))}"`,
      );
      await assertRejects(
        // @ts-expect-error a component is a function or JSX
        () => imports(new SignalComponent(() => ({ Box: 1 }))),
        TypeError,
        "'Box' is neither",
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name:
    "signal.name.initial and a signal placed as a child render its initial value",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-bind";
    const counters = new Signals(import.meta.url, ({ Signal, Computed }) => {
      const count = new Signal(3);
      const doubled = new Computed(() => count.value * 2, [count]);
      return { count, doubled };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { signal } = await imports(counters);
      const html = String(
        jsx("p", {
          children: [
            signal.count,
            " doubled is ",
            signal.doubled,
          ],
        }),
      );
      assertEquals([signal.count.initial, signal.doubled.initial], [3, 6]);
      assertEquals(
        String(jsx(Fragment, { children: signal.count })),
        String(jsx("p", { children: signal.count })).slice(3, -4),
      );
      assertThrows(() => `${signal.count}`, Error, "turned into a string");
      const bound = (handler: string, value: number) =>
        `<signal-text tt-handler-connect="${handler}" tt-handler-signal="signals.setTextContent">${value}</signal-text>`;
      assertEquals(
        // Bundle names carry content hashes.
        html.replace(/(\w+)_[0-9a-f]{5}\./g, "$1."),
        `<p>${
          bound("signals.subscribe(signalImports_test.count)", 3)
        } doubled is ${
          bound("signals.subscribe(signalImports_test.doubled)", 6)
        }</p>`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "a signal given as value renders its initial value and stays live",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-value";
    const search = new Signals(import.meta.url, ({ Signal }) => ({
      query: new Signal("tea"),
      filter: new Signal(0),
    }));
    const clicks = new Handlers(import.meta.url, {
      focus(this: HTMLElement) {},
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { signal, fn } = await imports(search, clicks);
      const strings = (...parts: string[]) =>
        Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
      // Bundle names carry content hashes.
      const unhashed = (html: unknown) =>
        String(html).replace(/(\w+)_[0-9a-f]{5}\./g, "$1.");
      const alone =
        `value="tea" tt-value-signal="signalImports_test.query" tt-handler-connect="signals.subscribe(signalImports_test.query)" tt-handler-signal="signals.setBound"`;
      assertEquals(
        unhashed(jsx("input", { value: signal.query })),
        `<input value="tea" tt-value-signal="signalImports_test.query" tt-handler-connect="signals.subscribe(signalImports_test.query)" is="tt-input" tt-handler-signal="signals.setBound"/>`,
      );
      assertEquals(
        unhashed(jsxTemplate(
          strings("<input ", "/>"),
          jsxAttr("value", signal.query),
        )),
        `<input is="tt-input" ${alone}/>`,
      );
      // The element's own handlers follow the binding's, in either mode.
      const merged = [
        'value="tea"',
        'tt-value-signal="signalImports_test.query"',
        `tt-handler-connect="signals.subscribe(signalImports_test.query) signals.subscribe(signalImports_test.filter) signalImports_test.focus"`,
        `tt-handler-signal="signals.setBound signalImports_test.focus"`,
      ];
      const fromJsx = unhashed(jsx("input", {
        onConnect: [fn.signals.subscribe(signal.filter), fn.focus],
        value: signal.query,
        onSignal: fn.focus,
      }));
      for (const part of merged) assertStringIncludes(fromJsx, part);
      const precompiled = unhashed(jsxTemplate(
        strings("<input ", " ", " ", "/>"),
        jsxAttr("onConnect", [fn.signals.subscribe(signal.filter), fn.focus]),
        jsxAttr("value", signal.query),
        jsxAttr("onSignal", fn.focus),
      ));
      for (const part of merged) assertStringIncludes(precompiled, part);
      // Each attribute appears once.
      assertEquals(precompiled.match(/tt-handler-connect=/g)?.length, 1);
      assertEquals(precompiled.match(/tt-handler-signal=/g)?.length, 1);
      // Other elements with a value attribute take it as text.
      for (
        const html of [
          unhashed(jsx("option", { value: signal.query })),
          unhashed(jsxTemplate(
            strings("<meter ", "></meter>"),
            jsxAttr("value", signal.query),
          )),
        ]
      ) {
        assertStringIncludes(html, 'value="tea"');
        assertStringIncludes(
          html,
          'tt-value-signal="signalImports_test.query"',
        );
      }
      // A select renders no value, its options marking the initial one; on
      // connect it checks the option shown against the signal, in either
      // mode.
      for (
        const html of [
          unhashed(jsx("select", { value: signal.query })),
          unhashed(jsxTemplate(
            strings("<select ", "></select>"),
            jsxAttr("value", signal.query),
          )),
        ]
      ) {
        assertEquals(/ value=/.test(html), false);
        assertStringIncludes(
          html,
          'tt-value-signal="signalImports_test.query"',
        );
        assertStringIncludes(
          html,
          `tt-handler-connect="signals.subscribe(signalImports_test.query) signals.checkSelected"`,
        );
        assertStringIncludes(html, `tt-handler-signal="signals.setBound"`);
      }
      // A textarea's initial value is its text; the element's own onConnect
      // (fn.fireSelfSignal, say) follows the binding's signal.
      const textareaParts = [
        'tt-value-signal="signalImports_test.query"',
        `tt-handler-connect="signals.subscribe(signalImports_test.query) signalImports_test.focus"`,
        `tt-handler-signal="signals.setBound"`,
      ];
      const textarea = unhashed(jsx("textarea", {
        value: signal.query,
        onConnect: fn.focus,
      }));
      for (const part of textareaParts) assertStringIncludes(textarea, part);
      assertEquals(textarea.includes("value="), false);
      assertStringIncludes(textarea, ">tea</textarea>");
      assertThrows(
        () => jsx("textarea", { value: signal.query, children: "x" }),
        TypeError,
        "takes no children",
      );
      // withInitial() renders no initial value, so the textarea keeps its
      // own children as a placeholder, in either mode.
      for (
        const html of [
          unhashed(jsx("textarea", {
            value: signal.query.withInitial(),
            onConnect: fn.focus,
            children: "Loading…",
          })),
          unhashed(jsxTemplate(
            strings("<textarea ", " ", ">Loading…</textarea>"),
            jsxAttr("value", signal.query.withInitial()),
            jsxAttr("onConnect", fn.focus),
          )),
        ]
      ) {
        for (const part of textareaParts) assertStringIncludes(html, part);
        assertStringIncludes(html, ">Loading…</textarea>");
        assertEquals(html.includes("tea"), false);
        assertEquals(html.includes("value="), false);
      }
      // Elsewhere it leaves the attribute out, and child text starts empty.
      const withoutInitial = unhashed(jsx("div", {
        "data-status": signal.query.withInitial(),
        hidden: signal.query.withInitial(),
        children: signal.query.withInitial(),
      }));
      assertEquals(withoutInitial.includes("data-status="), false);
      assertEquals(withoutInitial.includes("hidden="), false);
      assertStringIncludes(withoutInitial, "></signal-text>");
      assertThrows(
        () =>
          jsxTemplate(
            strings("<textarea ", "></textarea>"),
            jsxAttr("value", signal.query),
          ),
        TypeError,
        "jsxPrecompileSkipElements",
      );
      // withInitial applies wherever the signal is bound or placed.
      assertStringIncludes(
        unhashed(jsx("input", { value: signal.query.withInitial("…") })),
        'value="…" tt-value-signal="signalImports_test.query"',
      );
      assertStringIncludes(
        unhashed(jsx("p", { children: signal.query.withInitial("Loading") })),
        ">Loading</signal-text>",
      );
      assertEquals(signal.query.withInitial("x").initial, "x");
      assertEquals(signal.query.initial, "tea");
      // A signal as checked renders checked only when its value is truthy.
      const unchecked = unhashed(jsx("input", {
        type: "checkbox",
        checked: signal.filter,
      }));
      assertEquals(unchecked.includes("checked="), false);
      assertStringIncludes(
        unchecked,
        'tt-checked-signal="signalImports_test.filter"',
      );
      assertStringIncludes(
        unchecked,
        `tt-handler-signal="signals.setBound"`,
      );
      // Both bound to one signal: subscribed once, the setter run once.
      // Deno's precompile writes `checked={x}` as `x ? "checked" : ""`, so an
      // input binding checked must be skipped (jsxPrecompileSkipElements).
      const both = unhashed(jsx("input", {
        type: "checkbox",
        value: signal.query,
        checked: signal.query,
      }));
      for (
        const part of [
          'value="tea"',
          'checked=""',
          'tt-value-signal="signalImports_test.query"',
          'tt-checked-signal="signalImports_test.query"',
          `tt-handler-connect="signals.subscribe(signalImports_test.query)"`,
          `tt-handler-signal="signals.setBound"`,
        ]
      ) assertStringIncludes(both, part);
      assertEquals(both.match(/tt-handler-connect=/g)?.length, 1);
      assertEquals(both.match(/tt-handler-signal=/g)?.length, 1);
      // An option takes a signal as selected, and only an option does.
      assertEquals(
        unhashed(jsx("option", {
          value: "tea",
          selected: signal.query,
          children: "Tea",
        })),
        `<option value="tea" selected="" tt-selected-signal="signalImports_test.query" tt-handler-connect="signals.subscribe(signalImports_test.query)" is="tt-option" tt-handler-signal="signals.setBound">Tea</option>`,
      );
      assertStringIncludes(
        unhashed(jsx("option", { selected: signal.filter })),
        "<option tt-selected-signal=",
      );
      assertThrows(
        () => jsx("input", { selected: signal.query }),
        TypeError,
        "<input> cannot take a signal as its selected; only <option> can",
      );
      assertThrows(
        () => jsx("option", { checked: signal.query }),
        TypeError,
        "<option> cannot take a signal as its checked; only <input> can",
      );
      // Any element takes a signal as hidden; form controls as disabled.
      for (
        const [tag, property] of [
          ["div", "hidden"],
          ["button", "disabled"],
          ["select", "disabled"],
        ]
      ) {
        const html = unhashed(jsx(tag, { [property]: signal.query }));
        assertStringIncludes(
          html,
          `<${tag} ${property}="" tt-${property}-signal=`,
        );
        assertStringIncludes(html, `tt-handler-signal="signals.setBound"`);
        assertEquals(
          unhashed(jsx(tag, { [property]: signal.filter })).includes(
            `${property}=""`,
          ),
          false,
        );
      }
      assertThrows(
        () => jsx("div", { disabled: signal.query }),
        TypeError,
        "only <button>, <fieldset>, <input>, <optgroup>, <option>, <select> or <textarea> can",
      );
      // src is text on media tags; withInitial renders the given URL.
      for (
        const html of [
          unhashed(jsx("img", { src: signal.query.withInitial("/a.png") })),
          unhashed(jsxTemplate(
            strings("<img ", " />"),
            jsxAttr("src", signal.query.withInitial("/a.png")),
          )),
        ]
      ) {
        assertStringIncludes(html, 'src="/a.png"');
        assertStringIncludes(
          html,
          'tt-src-signal="signalImports_test.query"',
        );
      }
      assertThrows(
        () => jsx("div", { src: signal.query }),
        TypeError,
        "only <img>, <source>, <video>, <audio> or <iframe> can",
      );
      // Precompile passes hidden to jsxAttr: false leaves it out, not "false".
      for (
        const [bound, expected] of [[signal.filter, ""], [
          signal.query,
          'hidden=""',
        ]] as const
      ) {
        const html = unhashed(jsxTemplate(
          strings("<div ", "></div>"),
          jsxAttr("hidden", bound),
        ));
        assertEquals(html.includes('hidden="false"'), false);
        if (expected) assertStringIncludes(html, expected);
        assertStringIncludes(html, `tt-handler-signal="signals.setBound"`);
      }
      // data-* and aria-* attributes take a signal on any element, as text
      // (0 stays "0"); setBound runs once for all of them.
      const attributeParts = [
        'data-status="tea"',
        'aria-expanded="0"',
        'tt-data-status-signal="signalImports_test.query"',
        'tt-aria-expanded-signal="signalImports_test.filter"',
        `tt-handler-connect="signals.subscribe(signalImports_test.query) signals.subscribe(signalImports_test.filter)"`,
        `tt-handler-signal="signals.setBound"`,
      ];
      const attributesFromJsx = unhashed(jsx("div", {
        "data-status": signal.query,
        "aria-expanded": signal.filter,
        hidden: signal.filter,
      }));
      const attributesPrecompiled = unhashed(jsxTemplate(
        strings("<div ", " ", " ", "></div>"),
        jsxAttr("data-status", signal.query),
        jsxAttr("aria-expanded", signal.filter),
        jsxAttr("hidden", signal.filter),
      ));
      for (const html of [attributesFromJsx, attributesPrecompiled]) {
        for (const part of attributeParts) assertStringIncludes(html, part);
        assertEquals(html.match(/tt-handler-signal=/g)?.length, 1);
        assertEquals(html.includes("hidden="), false);
      }
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "collection.withInputs() starts imported signals from those inputs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-with-inputs";
    const wages = new Signals(import.meta.url, ({ Signal, Computed }) => {
      const production = new Signal<number>(0);
      const pay = new Computed(() => `$${production.value * 0.4}`, [
        production,
      ]);
      return { production, pay };
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const withInputs = wages.withInputs({ production: 1000 });
      // Anywhere but tiny.imports() it is the collection itself.
      assertEquals(withInputs.instanceKey, wages.instanceKey);
      assertEquals(withInputs.evaluateUsingInitialValues().pay, "$0");
      const { signal } = await imports(withInputs);
      assertEquals([signal.production.initial, signal.pay.initial], [
        1000,
        "$400",
      ]);
      assertStringIncludes(
        String(jsx("p", { children: signal.pay })),
        ">$400</signal-text>",
      );
      // Inputs belong to that import only.
      assertEquals((await imports(wages)).signal.pay.initial, "$0");
      const { signal: wrong } = await imports(
        wages.withInputs({ pay: "$1" } as never),
      );
      assertThrows(() => wrong.pay.initial, Error);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "tiny.imports() gives each imported level's InstanceRoot as root",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/signal-roots";
    const picker = new Signals(
      import.meta.url,
      ({ Signal, Scope }) => ({
        picker: new Scope(() => ({ patientId: new Signal<string>("") })),
        query: new Signal<string>(""),
      }),
    );
    const lines = new Signals(
      import.meta.url,
      ({ Signal, Scope }) =>
        new Scope(() => ({ quantity: new Signal<number>(1) })),
    );
    const other = new Signals(
      import.meta.url,
      ({ Signal, Scope }) => ({
        picker: new Scope(() => ({ id: new Signal<string>("") })),
      }),
    );
    const tagOf = (html: unknown) =>
      /^<[^>]*>/.exec(String(html))![0].replaceAll("&#34;", "&quot;");
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const { signalRoot: root } = await imports(
        picker.withInputs(undefined, { patientId: "10972" }),
        lines,
      );
      // A seeded import seeds its roots; an unseeded one only marks them.
      const pickerRoot = tagOf(
        root.picker({ children: jsx("patient-picker", {}) as never }),
      );
      assertStringIncludes(
        pickerRoot,
        `tt-instance="${picker.scopes.picker.key}"`,
      );
      assertStringIncludes(
        pickerRoot,
        `tt-seed="${
          picker.scopes.picker.seed({ patientId: "10972" }).replaceAll(
            '"',
            "&quot;",
          )
        }"`,
      );
      assertEquals(
        tagOf(root.self({ children: jsx("tr", {}) as never })),
        `<tr is="tt-tr" tt-instance="${lines.instanceKey}">`,
      );
      // @ts-expect-error No imported collection has this level.
      assertThrows(() => root.missing, TypeError, "no imported signal");
      // A level two collections share is ambiguous.
      const { signalRoot: both } = await imports(picker, other);
      assertThrows(() => both.picker, TypeError, "is ambiguous");
      // An unnamed Scope holding nothing writable still has its self root.
      const pings = new Signals(
        new URL("./pings.ts", import.meta.url).href,
        ({ Trigger, Scope }) => new Scope(() => ({ ping: new Trigger() })),
      );
      const { signalRoot: pingRoot } = await imports(pings);
      assertEquals(
        tagOf(pingRoot.self({ children: jsx("p", {}) as never })),
        `<p is="tt-p" tt-instance="${pings.instanceKey}">`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test("seed() of a withInputs() collection seeds each level from its seed", async () => {
  const picker = new Signals(
    import.meta.url,
    ({ Signal, Scope }) =>
      new Scope(() => ({
        query: new Signal<string>(""),
        row: new Scope(() => ({ patientId: new Signal<string>("") })),
      })),
  );
  const seeded = picker.withInputs(undefined, {
    query: "smi",
    patientId: "10972",
  });
  // Each level takes the values of its own signals.
  assertEquals(seeded.seed(), picker.seed({ query: "smi" }));
  assertEquals(
    seeded.scopes.row.seed(),
    picker.scopes.row.seed({ patientId: "10972" }),
  );
  assertEquals(seeded.scopes.row.key, picker.scopes.row.key);
  // Values given still win.
  assertEquals(
    seeded.scopes.row.seed({ patientId: "1" }),
    picker.scopes.row.seed({ patientId: "1" }),
  );
  // Without a seed, a level starts fresh.
  assertEquals(
    picker.withInputs().scopes.row.seed(),
    picker.scopes.row.seed({}),
  );
  // @ts-expect-error The collection itself has no seed to fall back on.
  picker.scopes.row.seed();

  // InstanceRoot puts tt-instance and tt-seed on the one element it wraps,
  // in both JSX modes, and the root stays the enclosing component's to mark.
  const strings = (...parts: string[]) =>
    Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
  const rootOf = (html: unknown) => {
    const tag = /^<[^>]*>/.exec(String(html))![0].replaceAll("&#34;", "&quot;");
    return {
      instance: / tt-instance="([^"]*)"/.exec(tag)?.[1],
      seed: / tt-seed="([^"]*)"/.exec(tag)?.[1]?.replaceAll("&quot;", '"'),
      component: / data-tc="([^"]*)"/.exec(tag)?.[1],
    };
  };
  const wrapped = (
    Root: unknown,
    precompiled: boolean,
  ) => {
    const Card = () =>
      jsx(Root as never, {
        children: precompiled
          ? jsxTemplate(strings('<section class="card">', "</section>"), "b")
          : jsx("section", { class: "card", children: "b" }),
      });
    return String(jsx(Card, {}));
  };
  for (const precompiled of [false, true]) {
    assertEquals(rootOf(wrapped(seeded.scopes.row.InstanceRoot, precompiled)), {
      instance: picker.scopes.row.key,
      seed: picker.scopes.row.seed({ patientId: "10972" }),
      component: "Card",
    });
    assertEquals(rootOf(wrapped(seeded.InstanceRoot, precompiled)), {
      instance: picker.instanceKey,
      seed: picker.seed({ query: "smi" }),
      component: "Card",
    });
    // Unseeded, it only marks the root.
    assertEquals(rootOf(wrapped(picker.scopes.row.InstanceRoot, precompiled)), {
      instance: picker.scopes.row.key,
      seed: undefined,
      component: "Card",
    });
  }
  // A seed prop seeds it, and wins over a withInputs() seed.
  assertEquals(
    rootOf(jsx(seeded.InstanceRoot as never, {
      seed: { query: "x" },
      children: jsx("section", {}),
    })).seed,
    picker.seed({ query: "x" }),
  );
  // Precompiled markup with async content inside arrives as a promise.
  assertEquals(
    rootOf(
      await jsx(picker.scopes.row.InstanceRoot as never, {
        children: Promise.resolve(
          jsxTemplate(strings('<section class="card">', "</section>"), "b"),
        ),
      }),
    ).instance,
    picker.scopes.row.key,
  );
  // It wraps one element, not several.
  assertThrows(
    () =>
      jsx(picker.scopes.row.InstanceRoot as never, {
        children: [jsx("p", {}), jsx("p", {})],
      }),
    TypeError,
    "wraps exactly one element",
  );
  // Or a component returning one, whose own root it marks once Hono renders
  // it, in both modes, inside the context its providers give.
  const Context = createContext("default");
  for (const precompiled of [false, true]) {
    const Item = () =>
      precompiled
        ? jsxTemplate(
          strings('<li class="item">', "</li>"),
          useContext(Context),
        )
        : jsx("li", { class: "item", children: useContext(Context) });
    const html = await jsx(Context.Provider as never, {
      value: "provided",
      children: jsx(picker.scopes.row.InstanceRoot as never, {
        children: jsx(Item, {}),
      }),
    }).toString();
    assertEquals(rootOf(html), {
      instance: picker.scopes.row.key,
      seed: undefined,
      component: "Item",
    });
    assertStringIncludes(html, ">provided</li>");
  }
  // Nested, the wrappers root one element in every level they name: the keys
  // listed in tt-instance, each level's seed under its key in one tt-seed,
  // and a key written by hand kept.
  const badge = new Signals(
    new URL("./badge.ts", import.meta.url).href,
    ({ Signal, Scope }) => new Scope(() => ({ tone: new Signal<string>("") })),
  );
  const seededBadge = badge.withInputs(undefined, { tone: "warm" });
  for (const precompiled of [false, true]) {
    const html = await jsx(seeded.InstanceRoot as never, {
      children: jsx(seededBadge.InstanceRoot as never, {
        children: jsx(picker.scopes.row.InstanceRoot as never, {
          children: precompiled
            ? jsxTemplate(
              strings(
                '<section tt-instance="by-hand" class="card">',
                "</section>",
              ),
              "b",
            )
            : jsx("section", {
              "tt-instance": "by-hand",
              class: "card",
              children: "b",
            }),
        }),
      }),
    }).toString();
    const root = rootOf(html);
    assertEquals(
      root.instance,
      `by-hand ${picker.scopes.row.key} ${badge.instanceKey} ${picker.instanceKey}`,
    );
    assertEquals(JSON.parse(root.seed!), {
      [badge.instanceKey]: { tone: "warm" },
      [picker.instanceKey]: { query: "smi" },
    });
    assertEquals(html.match(/ tt-instance=/g)?.length, 1);
    assertEquals(html.match(/ tt-seed=/g)?.length, 1);
    assertStringIncludes(html, 'class="card"');
  }
  // The root becomes a lifecycle element, so its instance is parked when it
  // is removed: a custom tag is declared, a plain one becomes a customized
  // built-in, and an is="..." without a hyphen is left alone.
  const tracker = createNoContextToolUsageTracker();
  const lifecycle = await withNoContextToolUsageTracker(tracker, async () =>
    [
      await jsx(picker.scopes.row.InstanceRoot as never, {
        children: jsx("note-card", {}),
      }).toString(),
      await jsx(picker.scopes.row.InstanceRoot as never, {
        children: jsxTemplate(strings("<fieldset>", "</fieldset>"), "x"),
      }).toString(),
      await jsx(picker.scopes.row.InstanceRoot as never, {
        children: jsx("li", { is: "plain" }),
      }).toString(),
    ].map((html) => /^<[^>]*>/.exec(html)![0]));
  assertEquals(lifecycle.map((tag) => / is="([^"]*)"/.exec(tag)?.[1]), [
    undefined,
    "tt-fieldset",
    "plain",
  ]);
  assertEquals([...tracker.accessedLifecycleTags].sort(), [
    "note-card",
    "tt-fieldset:fieldset",
  ]);
  const Pair = () => jsx(Fragment, { children: [jsx("p", {}), jsx("p", {})] });
  assertThrows(
    () =>
      String(
        jsx(picker.scopes.row.InstanceRoot as never, {
          children: jsx(Pair, {}),
        }),
      ),
    TypeError,
    "wraps <Pair>, which must return exactly one element",
  );
  // Without an unnamed Scope, only a named level has roots.
  const named = new Signals(
    import.meta.url,
    ({ Signal, Scope }) => ({
      row: new Scope(() => ({ id: new Signal<string>("") })),
    }),
  );
  assertThrows(
    () => jsx(named.InstanceRoot as never, { children: jsx("p", {}) }),
    TypeError,
    "use scopes.<name>.InstanceRoot",
  );
});

Deno.test("a build writes signalTools only for an app that defines signals", async () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/signal-build.ts", import.meta.url),
  );
  /** Whether a fresh build wrote the bundle holding `setTextContent`. */
  const writesSignalTools = async (kind: string) => {
    const directory = `./.test-build-output/signal-build-${kind}`;
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-lock", "-A", fixture, directory, kind],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.code,
        0,
        new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
      );
      for await (const entry of Deno.readDir(`${directory}/handlers`)) {
        const code = await Deno.readTextFile(
          `${directory}/handlers/${entry.name}`,
        );
        if (code.includes("setTextContent")) return true;
      }
      return false;
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    }
  };
  assertEquals(await writesSignalTools("signals"), true);
  assertEquals(await writesSignalTools("handlers"), false);
});
