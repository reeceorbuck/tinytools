/** @jsxImportSource @tinytools/hono-tools */
/** @jsxImportSourceTypes @tinytools/hono-tools */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Handlers, imports } from "../clientTools.ts";
import type { HandlerReference } from "../eventAttributes.ts";

const tools = new Handlers(import.meta.url, {
  click: function (this: HTMLButtonElement, event: MouseEvent) {
    this.textContent = event.type;
  },
  keyboard: function (event: KeyboardEvent) {
    console.log(event.key);
  },
  generic: function (event: Event) {
    console.log(event.type);
  },
});

Deno.test("compiled TSX supports direct references, spreads and component forwarding", async () => {
  const { fn, handlers, events } = await imports(tools);
  const direct = String(
    <button type="button" onClick={handlers.click}>Count</button>,
  );
  const spread = String(
    <button type="button" {...events({ click: handlers.click })}>Count</button>,
  );
  assertEquals(direct, spread);
  assertEquals(
    String(
      <button type="button" {...{ onClick: handlers.click }}>Count</button>,
    ),
    spread,
  );
  assertStringIncludes(
    String(<button type="button" onClick={fn.click}>Count</button>),
    String(fn.click),
  );
  const Button = (
    props: { onClick: HandlerReference<"click", (event: MouseEvent) => void> },
  ) => <button type="button" onClick={props.onClick}>Count</button>;
  assertEquals(String(<Button onClick={handlers.click} />), direct);
  assertStringIncludes(
    String(<button type="button" onclick={handlers.click}>Count</button>),
    "tt-handler-click=",
  );
});

async function checkTypes() {
  const { handlers } = await imports(tools);
  <button
    type="button"
    onClick={handlers.click}
    onKeyDown={handlers.keyboard}
  />;
  // @ts-expect-error Event signatures must match.
  <button type="button" onKeyDown={handlers.click} />;
  // @ts-expect-error Unknown handlers are not available.
  <button type="button" onClick={handlers.missing} />;
  // @ts-expect-error Raw functions remain forbidden.
  <button type="button" onClick={() => {}} />;
  // @ts-expect-error Lifecycle hooks still require legacy activated handlers.
  <lifecycle-element onMount={handlers.click} />;
  // @ts-expect-error Custom window hooks still require legacy handlers.
  <window-event-listener onResize={handlers.generic} />;
}
void checkTypes;
