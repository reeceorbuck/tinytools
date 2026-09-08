import { assertEquals } from "@std/assert";
import {
  Handlers,
  imports,
  Styles,
  withNoContextToolUsageTracker,
} from "../clientTools.ts";
import { eventHandlerBody } from "../eventAttributes.ts";
import type { JSX } from "../jsx-runtime.ts";

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

Deno.test("imports events track only accessed assets without context", async () => {
  const tracker = {
    accessedHandlerFiles: new Set<string>(),
    accessedStyleFiles: new Set<string>(),
  };
  await withNoContextToolUsageTracker(tracker, async () => {
    const { events, handlers: references } = await imports(handlers, styles);
    const attributes = events({ click: references.click });
    assertEquals(attributes, events({ click: "click" }));
    const props: JSX.IntrinsicElements["button"] = attributes;
    assertEquals(String(props.onclick), eventHandlerBody);
    assertEquals(
      [...tracker.accessedHandlerFiles],
      [attributes["tt-handler-click"] + ".js"],
    );
    assertEquals(tracker.accessedStyleFiles.size, 0);
    const html = String(<button {...attributes}>Test</button>);
    assertEquals(html.includes('tt-handler-click="click_'), true);
    const expected = String(
      <button {...events({ click: "click" })}>Test</button>,
    );
    assertEquals(html, expected);
  });
});

async function checkImportTypes() {
  const { fn, events, handlers: references } = await imports(handlers, styles);
  events({ click: references.click, keydown: references.keyboard });
  // @ts-expect-error Event signatures remain checked for references.
  events({ keydown: references.click });
  const foreign = await imports(unrelated);
  // @ts-expect-error Same-signature handlers with unimported names are rejected.
  events({ click: foreign.handlers.unrelatedClick });
  events({ click: "click", keydown: "keyboard" });
  // @ts-expect-error Names must come from the explicit imports.
  events({ click: "unrelatedClick" });
  // @ts-expect-error Keyboard handlers cannot handle mouse events.
  events({ click: "keyboard" });
  // @ts-expect-error Activated expressions are not handler names.
  events({ click: fn.click });
  const onlyStyles = await imports(styles);
  // @ts-expect-error Style imports expose no handler references.
  onlyStyles.handlers.click;
  // @ts-expect-error Styles do not import handlers.
  onlyStyles.events({ click: "click" });
  const extended = await unrelated.extend(handlers).engage();
  extended.events({ click: "unrelatedClick", keydown: "keyboard" });
  extended.events({ click: extended.handlers.unrelatedClick });
}
void checkImportTypes;
