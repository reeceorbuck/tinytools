import { assertEquals, assertThrows } from "@std/assert";
import { createEvents, eventHandlerBody } from "../eventAttributes.ts";

type Handlers = {
  click: (this: HTMLButtonElement, event: MouseEvent) => void;
  submit: (event: SubmitEvent) => void;
  anyEvent: (event: Event) => void;
};

const events = createEvents<Handlers>((name) =>
  ["click", "submit", "anyEvent"].includes(name)
    ? `handlers.${name}_123.call(this, event)`
    : undefined
);

Deno.test("events emit identical bodies and separate handler IDs", () => {
  const attributes = events({ click: "click", mouseover: "anyEvent" });
  assertEquals(String(attributes.onclick), eventHandlerBody);
  assertEquals(String(attributes.onmouseover), eventHandlerBody);
  assertEquals(attributes["tt-handler-click"], "click_123");
  assertEquals(attributes["tt-handler-mouseover"], "anyEvent_123");
  assertEquals(events({}), {});
  assertThrows(() => events({ click: "missing" } as never), TypeError);
});

Deno.test("events dispatch with the receiver, event and return value", () => {
  const attributes = events({ click: "click" });
  const element = {
    getAttribute: (name: string) => attributes[name as keyof typeof attributes],
  };
  const event = new Event("click");
  const handler = function (this: unknown, received: Event) {
    assertEquals(this, element);
    assertEquals(received, event);
    return false;
  };
  const dispatch = new Function("globalThis", "event", eventHandlerBody);
  assertEquals(
    dispatch.call(element, { handlers: { click_123: handler } }, event),
    false,
  );
});

function checkTypes() {
  events({ click: "click", submit: "submit", keydown: "anyEvent" });
  // @ts-expect-error Unknown handler names are not imported.
  events({ click: "missing" });
  // @ts-expect-error MouseEvent handlers cannot receive keyboard events.
  events({ keydown: "click" });
  // @ts-expect-error Unknown event names are not allowed.
  events({ clik: "click" });
  // @ts-expect-error Raw functions are not imported handler names.
  events({ click: () => {} });
}
void checkTypes;
