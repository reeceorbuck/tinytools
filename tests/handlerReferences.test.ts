import { assertEquals, assertThrows } from "@std/assert";
import {
  createHandlerReferences,
  eventHandlerBody,
} from "../eventAttributes.ts";
import { jsx } from "../jsx-runtime.ts";

type Functions = {
  click: (event: MouseEvent) => void;
  keyboard: (event: KeyboardEvent) => void;
};

const handlers = createHandlerReferences<Functions>((name) =>
  ["click", "keyboard"].includes(name) ? `bundle_123.${name}` : undefined
);

Deno.test("handler references render as <bundle>.<name>", () => {
  assertEquals(
    String(
      jsx("input", { onClick: handlers.click, onKeyDown: handlers.keyboard }),
    ),
    `<input onclick="${eventHandlerBody}" tt-handler-click="bundle_123.click" onkeydown="${eventHandlerBody}" tt-handler-keydown="bundle_123.keyboard"/>`,
  );
});

Deno.test("handler references reject malformed IDs and forged objects", () => {
  const malformed = createHandlerReferences<Functions>((name) =>
    `handlers.other_456.${name}.call(this, event)`
  );
  assertThrows(() => jsx("button", { onClick: malformed.click }), TypeError);
  assertThrows(() => jsx("button", { onClick: [{}] }), TypeError);
});
