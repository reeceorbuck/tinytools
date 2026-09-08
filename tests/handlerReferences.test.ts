import { assertEquals, assertThrows } from "@std/assert";
import { createEvents, createHandlerReferences } from "../eventAttributes.ts";

type Functions = {
  click: (event: MouseEvent) => void;
  keyboard: (event: KeyboardEvent) => void;
};

const resolve = (name: string) =>
  ["click", "keyboard"].includes(name)
    ? `handlers.${name}_123.call(this, event)`
    : undefined;
const events = createEvents<Functions>(resolve);
const handlers = createHandlerReferences<Functions>(resolve);

Deno.test("handler references emit the same attributes as names", () => {
  assertEquals(
    events({ click: handlers.click, keydown: handlers.keyboard }),
    events({ click: "click", keydown: "keyboard" }),
  );
});

Deno.test("handler references reject foreign IDs and forged objects", () => {
  const foreign = createHandlerReferences<Functions>((name) =>
    `handlers.${name}_other.call(this, event)`
  );
  assertThrows(() => events({ click: foreign.click }), TypeError);
  assertThrows(() => events({ click: {} } as never), TypeError);
  const otherEvents = createEvents<Functions>(() => undefined);
  assertThrows(() => otherEvents({ click: handlers.click }), TypeError);
});

function checkTypes() {
  events({ click: handlers.click, keydown: handlers.keyboard });
  // @ts-expect-error Incompatible event signature.
  events({ keydown: handlers.click });
  // @ts-expect-error Unknown property.
  events({ click: handlers.missing });
  const foreign = createHandlerReferences<{ other: Functions["click"] }>(
    resolve,
  );
  // @ts-expect-error Matching signatures cannot bypass imported handler names.
  events({ click: foreign.other });
  // @ts-expect-error References are not callable server functions.
  handlers.click(new MouseEvent("click"));
}
void checkTypes;
