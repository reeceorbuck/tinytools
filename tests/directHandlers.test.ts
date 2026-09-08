import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createEvents,
  createHandlerReferences,
  eventHandlerBody,
} from "../eventAttributes.ts";
import { jsx, jsxAttr, jsxs, jsxTemplate } from "../jsx-runtime.ts";
import { jsxDEV } from "../jsx-dev-runtime.ts";

const resolve = (name: string) => `handlers.${name}_123.call(this, event)`;
const handlers = createHandlerReferences<
  { click: (event: MouseEvent) => void }
>(resolve);
const events = createEvents<{ click: (event: MouseEvent) => void }>(resolve);

Deno.test("direct references expand in normal and dev JSX without mutating props", () => {
  const props = { onClick: handlers.click, children: "Count" };
  const reference = props.onClick;
  const expected = String(
    jsx("button", { ...events({ click: handlers.click }), children: "Count" }),
  );
  for (const render of [jsx, jsxs, jsxDEV]) {
    assertEquals(String(render("button", props)), expected);
  }
  assertEquals(props.onClick, reference);
  assertEquals(Object.keys(props), ["onClick", "children"]);
});

Deno.test("precompiled attribute helper emits both escaped attributes", () => {
  const html = String(
    jsxTemplate`<button ${jsxAttr("onClick", handlers.click)}>Count</button>`,
  );
  assertEquals(
    html,
    String(
      jsx("button", {
        ...events({ click: handlers.click }),
        children: "Count",
      }),
    ),
  );
  assertStringIncludes(html, 'tt-handler-click="click_123"');
});

Deno.test("ordinary attributes, inline expressions and component props are preserved", () => {
  assertStringIncludes(
    String(jsx("button", { onClick: resolve("click") })),
    resolve("click"),
  );
  assertEquals(String(jsxAttr("title", 'a"b')), 'title="a&quot;b"');
  const reference = handlers.click;
  const Component = (props: Record<string, unknown>) => {
    assertEquals(props.onClick, reference);
    return jsx("button", props);
  };
  assertStringIncludes(
    String(jsx(Component, { onClick: reference })),
    eventHandlerBody,
  );
  assertThrows(() => jsx("div", { title: reference }), TypeError);
  assertThrows(
    () => jsx("lifecycle-element", { onMount: reference }),
    TypeError,
  );
});
