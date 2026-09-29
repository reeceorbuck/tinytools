import { assertEquals } from "@std/assert";
import { tiny } from "../honoFactory.tsx";
import type { ImportedTools } from "../mod.ts";

const buttons = new tiny.Handlers(import.meta.url, {
  click(this: HTMLButtonElement, event: MouseEvent) {
    this.textContent = event.type;
  },
});
const keyboard = new tiny.Handlers(import.meta.url, {
  keydown(event: KeyboardEvent) {
    console.log(event.key);
  },
});
const styles = new tiny.Styles(import.meta.url, { panel: "color: red;" });

Deno.test("imports infer all explicit collections and preserve JSX signatures", async () => {
  const { fn, styled, handlers, events } = await tiny.imports(
    buttons,
    keyboard,
    styles,
  );
  const className: string = styled.panel;
  const element = (
    <button class={className} onClick={fn.click} onKeyDown={fn.keydown}>
      Test
    </button>
  );
  assertEquals(String(element).includes("tt-handler-click"), true);
  assertEquals(typeof handlers.click, "string");
  events({ click: fn.click, keydown: "keydown" });
});

async function checkTypes() {
  const local = await tiny.imports(buttons);
  // @ts-expect-error Collections are not inherited from other imports.
  local.fn.keydown;
  // @ts-expect-error Unimported styles are unavailable.
  local.styled.panel;
  const keys = await tiny.imports(keyboard);
  // @ts-expect-error Keyboard handlers do not handle mouse events.
  local.events({ click: keys.fn.keydown });
  // @ts-expect-error Native JSX retains handler event types.
  const invalid = <button onClick={keys.fn.keydown} />;
  const contextOnly = await tiny.imports();
  // @ts-expect-error Context access does not implicitly import handlers.
  contextOnly.fn.click;
  const typed: ImportedTools<{ click: (event: MouseEvent) => void }, {}> =
    local;
  void [invalid, typed];
}
void checkTypes;
