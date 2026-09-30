/** @jsxImportSource @tinytools/hono-tools */
/** @jsxImportSourceTypes @tinytools/hono-tools */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Handlers, imports } from "../clientTools.ts";
import { eventHandlerBody, type HandlerReference } from "../eventAttributes.ts";

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
  currentEntryChange: function (event: NavigationCurrentEntryChangeEvent) {
    console.log(event.navigationType);
  },
});

Deno.test("compiled TSX supports direct references, spreads and component forwarding", async () => {
  const { fn, handlers, events } = await imports(tools);
  const direct = String(
    <button type="button" onClick={fn.click}>Count</button>,
  );
  const spread = String(
    <button type="button" {...events({ click: fn.click })}>Count</button>,
  );
  assertEquals(direct, spread);
  assertEquals(
    String(
      <button type="button" {...{ onClick: fn.click }}>Count</button>,
    ),
    spread,
  );
  assertStringIncludes(
    String(<button type="button" onClick={handlers.click}>Count</button>),
    String(handlers.click),
  );
  const Button = (
    props: { onClick: HandlerReference<"click", (event: MouseEvent) => void> },
  ) => <button type="button" onClick={props.onClick}>Count</button>;
  assertEquals(
    String(<Button onClick={fn.click} />),
    direct.replace(">Count", ' data-tc="Button">Count'),
  );
  assertStringIncludes(
    String(<button type="button" onclick={fn.click}>Count</button>),
    "tt-handler-click=",
  );
});

async function checkTypes() {
  const { fn } = await imports(tools);
  <button type="button" onClick={[fn.click, fn.generic]} />;
  <button type="button" onClick={[fn.click, fn.generic] as const} />;
  // @ts-expect-error Every handler must accept the event type.
  <button type="button" onClick={[fn.click, fn.keyboard]} />;
  // @ts-expect-error Raw functions remain forbidden in arrays.
  <button type="button" onClick={[fn.click, () => {}]} />;
  <button
    type="button"
    onClick={fn.click}
    onKeyDown={fn.keyboard}
  />;
  // @ts-expect-error Event signatures must match.
  <button type="button" onKeyDown={fn.click} />;
  // @ts-expect-error Unknown handlers are not available.
  <button type="button" onClick={fn.missing} />;
  // @ts-expect-error Raw functions remain forbidden.
  <button type="button" onClick={() => {}} />;
  // @ts-expect-error Lifecycle hooks are not supported on elements.
  <div onMount={fn.generic} />;
  // @ts-expect-error Lifecycle hooks are not supported on elements.
  <div onUnmount={fn.generic} />;
  <div onResize={fn.generic} />;
  <div onCurrentEntryChange={fn.currentEntryChange} />;
  // @ts-expect-error Forwarded events still require compatible handler signatures.
  <div onCurrentEntryChange={fn.keyboard} />;
}
void checkTypes;

Deno.test("compiled TSX supports space-separated handler arrays", async () => {
  const { fn, events } = await imports(tools);
  const names = `${events({ click: fn.click })["tt-handler-click"]} ${
    events({ click: fn.generic })["tt-handler-click"]
  }`;
  const html = String(
    <button type="button" onClick={[fn.click, fn.generic]}>Count</button>,
  );
  assertStringIncludes(html, `tt-handler-click="${names}"`);
  assertStringIncludes(html, `onclick="${eventHandlerBody}"`);
  assertEquals(html.includes("[object Object]"), false);
  assertEquals(
    String(<button type="button" onClick={[]}>Count</button>),
    '<button type="button">Count</button>',
  );
});

Deno.test("navigation event references emit bindings for explicit forwarding", async () => {
  const { fn } = await imports(tools);
  const html = String(<div onCurrentEntryChange={fn.currentEntryChange} />);
  assertStringIncludes(
    html,
    '.currentEntryChange"',
  );
  assertStringIncludes(html, `oncurrententrychange="${eventHandlerBody}"`);
  assertEquals(html.includes("[object Object]"), false);
});
