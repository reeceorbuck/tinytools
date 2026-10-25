/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assertEquals } from "@std/assert";
import {
  Handlers,
  imports,
  Styles,
  withNoContextToolUsageTracker,
} from "../clientTools.ts";
import { eventHandlerBody } from "../eventAttributes.ts";
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
    const html = String(
      <button type="button" onClick={local.fn.click}>Test</button>,
    );
    const handler = /tt-handler-click="(\w+)\.click"/.exec(html)?.[1];
    assertEquals([...handlerFiles], [`${handler}.js`]);
    assertEquals(typeof local.styled.button, "string");
    assertEquals(styleFiles.size, 1);
    assertEquals((await imports()).c, context);
    return context.text("OK");
  });
  const response = await app.request("/");
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "OK");
});

Deno.test("imports track only accessed assets without context", async () => {
  const tracker = {
    accessedHandlerFiles: new Set<string>(),
    accessedStyleFiles: new Set<string>(),
    accessedLifecycleTags: new Set<string>(),
  };
  await withNoContextToolUsageTracker(tracker, async () => {
    const { fn } = await imports(handlers, styles);
    const html = String(<button type="button" onClick={fn.click}>Test</button>);
    const handler = /tt-handler-click="(\w+)\.click"/.exec(html)?.[1];
    assertEquals(handler !== undefined, true);
    assertEquals(html.includes(`onclick="${eventHandlerBody}"`), true);
    assertEquals([...tracker.accessedHandlerFiles], [`${handler}.js`]);
    assertEquals(tracker.accessedStyleFiles.size, 0);
  });
});

async function checkImportTypes() {
  type PartialOnLoad = Parameters<typeof NewPartial>[0]["onLoad"];
  const partialTools = new Handlers(import.meta.url, {
    load: function (this: HTMLTemplateElement, _event: Event) {},
    keyboard: function (this: HTMLTemplateElement, _event: KeyboardEvent) {},
  });
  const partial = await imports(partialTools);
  const referenceLoad: PartialOnLoad = partial.fn.load;
  // @ts-expect-error Raw functions are not imported handler bindings.
  const rawLoad: PartialOnLoad = function (_event: Event) {};
  // @ts-expect-error Load events cannot satisfy keyboard handler requirements.
  const keyboardLoad: PartialOnLoad = partial.fn.keyboard;
  void [referenceLoad, rawLoad, keyboardLoad];
  const onlyStyles = await imports(styles);
  // @ts-expect-error Style imports expose no handler references.
  onlyStyles.fn.click;
  const extended = await imports(handlers, unrelated);
  <button
    type="button"
    onClick={extended.fn.unrelatedClick}
    onKeyDown={extended.fn.keyboard}
  />;
}
void checkImportTypes;
