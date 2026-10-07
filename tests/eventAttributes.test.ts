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
    ? `handlers.bundle_123.${name}.call(this, event)`
    : undefined
);

Deno.test("events emit identical bodies and separate handler IDs", () => {
  const attributes = events({ click: "click", mouseover: "anyEvent" });
  assertEquals(String(attributes.onclick), eventHandlerBody);
  assertEquals(String(attributes.onmouseover), eventHandlerBody);
  assertEquals(attributes["tt-handler-click"], "bundle_123.click");
  assertEquals(attributes["tt-handler-mouseover"], "bundle_123.anyEvent");
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
      if (path !== "/handlers/bundle_123.js") {
        throw new Error(`Unexpected bundle: ${path}`);
      }
      return Promise.resolve(handlers);
    });
    const calls: string[] = [];
    let names = "bundle_123.first bundle_123.second";
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
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["first:start", "second"]);
    pending.resolve();
    await pending.promise;
    assertEquals(calls, ["first:start", "second", "first:end"]);

    calls.length = 0;
    names = "bundle_123.second bundle_123.second";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { body: element },
    });
    receiver = globalThis as unknown as Window;
    dispatch(globalThis, event);
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["second", "second"]);

    calls.length = 0;
    names = "bundle_123.second";
    dispatch(globalThis, event);
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["second"]);
  } finally {
    pending.resolve();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

Deno.test("browser dispatcher runs registered bundles synchronously and imports the rest", async () => {
  const imported: string[] = [];
  const calls: string[] = [];
  const dispatch: typeof runHandler = new Function(
    "loadHandler",
    `return ${runHandler.toString().replace("import(", "loadHandler(")}`,
  )((path: string) => {
    imported.push(path);
    return Promise.resolve({ late: () => calls.push("late") });
  });
  const element = {
    getAttribute: () => "registered_1.early loading_2.late",
  } as unknown as HTMLElement;
  (globalThis as unknown as { handlers: unknown }).handlers = {
    registered_1: { early: () => calls.push("early") },
  };
  try {
    dispatch(element, new Event("navigate"));
    // The registered handler ran during the call, before any microtask.
    assertEquals(calls, ["early"]);
    assertEquals(imported, ["/handlers/loading_2.js"]);
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["early", "late"]);
  } finally {
    Reflect.deleteProperty(globalThis, "handlers");
  }
});

Deno.test("browser dispatcher keeps attribute order while bundles load", async () => {
  const loaders = new Map<string, PromiseWithResolvers<unknown>>();
  const calls: string[] = [];
  const dispatch: typeof runHandler = new Function(
    "loadHandler",
    `return ${runHandler.toString().replace("import(", "loadHandler(")}`,
  )((path: string) => {
    const pending = Promise.withResolvers<unknown>();
    loaders.set(path, pending);
    return pending.promise;
  });
  const element = {
    getAttribute: () => "slow_1.first fast_2.second registered_3.third",
  } as unknown as HTMLElement;
  (globalThis as unknown as { handlers: unknown }).handlers = {
    registered_3: { third: () => calls.push("third") },
  };
  try {
    dispatch(element, new Event("load"));
    // Only the first bundle is requested; the rest wait their turn.
    assertEquals([...loaders.keys()], ["/handlers/slow_1.js"]);
    assertEquals(calls, []);

    loaders.get("/handlers/slow_1.js")!.resolve({
      first: () => calls.push("first"),
    });
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["first"]);
    assertEquals([...loaders.keys()], [
      "/handlers/slow_1.js",
      "/handlers/fast_2.js",
    ]);

    loaders.get("/handlers/fast_2.js")!.resolve({
      second: () => calls.push("second"),
    });
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["first", "second", "third"]);
  } finally {
    Reflect.deleteProperty(globalThis, "handlers");
  }
});

Deno.test("browser dispatcher runs the rest of the list after a failed bundle", async () => {
  const calls: string[] = [];
  const errors: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const dispatch: typeof runHandler = new Function(
    "loadHandler",
    `return ${runHandler.toString().replace("import(", "loadHandler(")}`,
  )((path: string) =>
    path === "/handlers/broken_1.js"
      ? Promise.reject(new Error("404"))
      : Promise.resolve({ late: () => calls.push("late") })
  );
  const element = {
    getAttribute: () => "broken_1.missing loading_2.late",
  } as unknown as HTMLElement;
  try {
    dispatch(element, new Event("load"));
    await new Promise((resolve) => setTimeout(resolve));
    assertEquals(calls, ["late"]);
    assertEquals(errors.length, 1);
    assertEquals(errors[0][0], "Handler broken_1.missing failed:");
  } finally {
    console.error = consoleError;
  }
});
