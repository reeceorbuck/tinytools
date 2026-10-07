import { assertEquals } from "@std/assert";
import {
  Handlers,
  imports,
  Styles,
  withNoContextToolUsageTracker,
} from "../clientTools.ts";
import { eventHandlerBody } from "../eventAttributes.ts";
import type { JSX } from "../jsx-runtime.ts";
import type { NewPartial } from "../components/NewPartial.tsx";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";

const handlers = new Handlers(import.meta.url, {
  click(this: HTMLButtonElement, event: MouseEvent) {
    this.textContent = event.type;
  },
  keyboard(event: KeyboardEvent) {
    console.log(event.key);
  },
});
const unrelated = new Handlers(import.meta.url, {
  unrelatedClick(event: MouseEvent) {
    console.log(event.type);
  },
});
const styles = new Styles(import.meta.url, { button: "color: red;" });

Deno.test("imports track explicit request assets without context tools", async () => {
  const app = new Hono<{
    Variables: {
      accessedHandlerFiles: Set<string>;
      accessedStyleFiles: Set<string>;
    };
  }>().use(contextStorage());
  app.get("/", async (context) => {
    const handlerFiles = new Set<string>();
    const styleFiles = new Set<string>();
    context.set("accessedHandlerFiles", handlerFiles);
    context.set("accessedStyleFiles", styleFiles);
    const local = await imports(handlers, styles);
    assertEquals(local.c, context);
    const attributes = local.events({ click: local.fn.click });
    assertEquals([...handlerFiles], [
      attributes["tt-handler-click"].split(".")[0] + ".js",
    ]);
    assertEquals(typeof local.styled.button, "string");
    assertEquals(styleFiles.size, 1);
    assertEquals((await imports()).c, context);
    return context.text("OK");
  });
  const response = await app.request("/");
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "OK");
});

Deno.test("imports events track only accessed assets without context", async () => {
  const tracker = {
    accessedHandlerFiles: new Set<string>(),
    accessedStyleFiles: new Set<string>(),
    accessedLifecycleTags: new Set<string>(),
  };
  await withNoContextToolUsageTracker(tracker, async () => {
    const { events, fn: references } = await imports(handlers, styles);
    const attributes = events({ click: references.click });
    assertEquals(attributes, events({ click: "click" }));
    const props: JSX.IntrinsicElements["button"] = attributes;
    assertEquals(String(props.onclick), eventHandlerBody);
    assertEquals(
      [...tracker.accessedHandlerFiles],
      [attributes["tt-handler-click"].split(".")[0] + ".js"],
    );
    assertEquals(tracker.accessedStyleFiles.size, 0);
    const html = String(<button {...attributes}>Test</button>);
    assertEquals(/tt-handler-click="\w+\.click"/.test(html), true);
    const expected = String(
      <button {...events({ click: "click" })}>Test</button>,
    );
    assertEquals(html, expected);
  });
});

async function checkImportTypes() {
  const { handlers: legacy, events, fn: references } = await imports(
    handlers,
    styles,
  );
  type PartialOnLoad = Parameters<typeof NewPartial>[0]["onLoad"];
  const partialTools = new Handlers(import.meta.url, {
    load: function (this: HTMLTemplateElement, _event: Event) {},
    keyboard: function (this: HTMLTemplateElement, _event: KeyboardEvent) {},
  });
  const partial = await imports(partialTools);
  const referenceLoad: PartialOnLoad = partial.fn.load;
  const legacyLoad: PartialOnLoad = partial.handlers.load;
  // @ts-expect-error Raw functions are not imported handler bindings.
  const rawLoad: PartialOnLoad = function (_event: Event) {};
  // @ts-expect-error Load events cannot satisfy keyboard handler requirements.
  const keyboardLoad: PartialOnLoad = partial.fn.keyboard;
  void [referenceLoad, legacyLoad, rawLoad, keyboardLoad];
  events({ click: references.click, keydown: references.keyboard });
  // @ts-expect-error Event signatures remain checked for references.
  events({ keydown: references.click });
  const foreign = await imports(unrelated);
  // @ts-expect-error Same-signature handlers with unimported names are rejected.
  events({ click: foreign.fn.unrelatedClick });
  events({ click: "click", keydown: "keyboard" });
  // @ts-expect-error Names must come from the explicit imports.
  events({ click: "unrelatedClick" });
  // @ts-expect-error Keyboard handlers cannot handle mouse events.
  events({ click: "keyboard" });
  // @ts-expect-error Activated expressions are not handler names.
  events({ click: legacy.click });
  const onlyStyles = await imports(styles);
  // @ts-expect-error Style imports expose no handler references.
  onlyStyles.fn.click;
  // @ts-expect-error Styles do not import handlers.
  onlyStyles.events({ click: "click" });
  const extended = await imports(handlers, unrelated);
  extended.events({ click: "unrelatedClick", keydown: "keyboard" });
  extended.events({ click: extended.fn.unrelatedClick });
}
void checkImportTypes;
