import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { Handlers, Styles } from "../clientTools.ts";
import { tiny } from "../mod.ts";
import { eventHandlerBody } from "../eventAttributes.ts";

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

Deno.test("events work alongside fn in request rendering and local imports", async () => {
  let expectedButton = "";
  const app = new Hono()
    .use(...tiny.middleware.core())
    .use(tiny.middleware.sharedImports(unrelated));

  app.get("/", async (context) => {
    const { fn, events, handlers: references } = await tiny.imports(
      handlers,
      styles,
    );
    const local = await context.var.tools.extendWithImports(handlers);
    assertEquals(
      String(local.events({ click: local.handlers.click }).onclick),
      eventHandlerBody,
    );
    const attributes = events({
      click: references.click,
      mouseover: references.click,
    });
    expectedButton = String(
      <button type="button" {...attributes}>Events</button>,
    );
    assertEquals(attributes, events({ click: "click", mouseover: "click" }));
    assertEquals(
      String(
        context.var.tools.events({
          click: context.var.tools.handlers.unrelatedClick,
        }).onclick,
      ),
      eventHandlerBody,
    );
    assertEquals(attributes.onclick, attributes.onmouseover);
    assertEquals(
      (context.var as unknown as { accessedHandlerFiles: Set<string> })
        .accessedHandlerFiles.has(attributes["tt-handler-click"] + ".js"),
      true,
    );
    return context.html(
      <div>
        <button type="button" onClick={fn.click}>Inline</button>
        <button type="button" {...attributes}>Events</button>
      </div>,
    );
  });
  const response = await app.request("/");
  const html = await response.text();
  assertEquals(response.status, 200, html);
  assertMatch(html, /onClick="handlers\.click_\w+\.call\(this, event\)"/i);
  assertStringIncludes(html, 'tt-handler-click="click_');
  assertStringIncludes(html, expectedButton);
});

async function checkImportTypes() {
  const { fn, events } = await tiny.imports(handlers, styles);
  events({ click: "click", keydown: "keyboard" });
  // @ts-expect-error Names must come from the explicit imports.
  events({ click: "unrelatedClick" });
  // @ts-expect-error Keyboard handlers cannot handle mouse events.
  events({ click: "keyboard" });
  // @ts-expect-error Activated inline expressions are not handler names.
  events({ click: fn.click });
  const onlyStyles = await tiny.imports(styles);
  // @ts-expect-error Styles do not import handlers.
  onlyStyles.events({ click: "click" });
  const extended = await unrelated.extend(handlers).engage();
  extended.events({ click: "unrelatedClick", keydown: "keyboard" });
}
void checkImportTypes;
