import { assertEquals, assertThrows } from "@std/assert";
import { createEvents, eventHandlerBody } from "../eventAttributes.ts";
import { runHandler } from "../honoFactory.tsx";

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

Deno.test("events delegate to tiny.runHandler with the element and event", () => {
  const attributes = events({ click: "click" });
  const element = {
    getAttribute: (name: string) => attributes[name as keyof typeof attributes],
  };
  const event = new Event("click");
  const handler = function (receivedElement: unknown, received: Event) {
    assertEquals(receivedElement, element);
    assertEquals(received, event);
    return false;
  };
  const dispatch = new Function("tiny", "event", eventHandlerBody);
  assertEquals(
    dispatch.call(element, { runHandler: handler }, event),
    undefined,
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

Deno.test("browser dispatcher starts every handler without awaiting and preserves receiver and event", async () => {
  const descriptors = new Map(
    ["document"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const pending = Promise.withResolvers<void>();
  try {
    const handlers: Record<
      string,
      (this: HTMLElement | Window, event: Event) => unknown
    > = {};
    const dispatch: typeof runHandler = new Function(
      "loadHandler",
      `return ${runHandler.toString().replace("import(", "loadHandler(")}`,
    )((path: string) => {
      const name = /^\/handlers\/(\w+)\.js$/.exec(path)?.[1];
      if (!name || !handlers[name]) {
        throw new Error(`Unexpected handler: ${path}`);
      }
      return Promise.resolve({ default: handlers[name] });
    });
    const calls: string[] = [];
    let names = "first second";
    const event = new Event("load");
    const element = {
      getAttribute(name: string) {
        assertEquals(name, "tt-handler-load");
        return names;
      },
    } as HTMLElement;
    let receiver: HTMLElement | Window = element;
    handlers.first = async function (
      this: HTMLElement | Window,
      received: Event,
    ) {
      assertEquals(this, receiver);
      assertEquals(received, event);
      calls.push("first:start");
      await pending.promise;
      calls.push("first:end");
    };
    handlers.second = function (this: HTMLElement | Window, received: Event) {
      assertEquals(this, receiver);
      assertEquals(received, event);
      calls.push("second");
      return false;
    };
    dispatch(element, event);
    await Promise.resolve();
    assertEquals(calls, ["first:start", "second"]);
    pending.resolve();
    await pending.promise;
    assertEquals(calls, ["first:start", "second", "first:end"]);

    calls.length = 0;
    names = "second second";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { body: element },
    });
    receiver = globalThis as unknown as Window;
    dispatch(globalThis, event);
    await Promise.resolve();
    assertEquals(calls, ["second", "second"]);

    calls.length = 0;
    names = "second";
    dispatch(globalThis, event);
    await Promise.resolve();
    assertEquals(calls, ["second"]);
  } finally {
    pending.resolve();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
