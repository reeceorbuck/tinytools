import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { processIncomingDataTools } from "../handlers/processIncomingData.ts";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

void processIncomingDataTools;
void partialInsertHandlers;
await Promise.all([
  processIncomingDataTools.ensureDefined(),
  partialInsertHandlers.ensureDefined(),
]);

type Handler = (this: unknown, event: Event) => unknown;
const builtHandlers = new Map<string, Handler>();
for (
  const name of ["appendIncomingHtml", "updateCachedRoutes", "partialReplace"]
) {
  builtHandlers.set(name, await loadHandler<Handler>(name));
}

function cachedRoute(updatePath: string, item: string) {
  return `<client-route path="/api/x" update-path="${updatePath}"><template for-partial-id="panel"><ul id="list"><li>${item}</li></ul></template></client-route>`;
}

Deno.test("updates apply to matching caches and only to a matching live page", () => {
  const { document, window } = parseHTML(
    `<html><body><section id="panel"><ul id="list"><li>live</li></ul></section><client-router cache-owner-id="panel"><template>${
      cachedRoute("/appointments/2026-10-02/5", "cached-5")
    }${cachedRoute("/patients/6", "cached-6")}${
      cachedRoute("/patients/5", "cached-5b")
    }</template></client-router><client-router cache-owner-id="other"><template>${
      cachedRoute("/patients/5", "other-5")
    }</template></client-router></body></html>`,
  );
  const location = { pathname: "/patients/7" };
  const globals: Record<string, unknown> = {
    document,
    location,
    tiny: {
      runHandler(element: Element, event: Event) {
        const name = element.getAttribute(`tt-handler-${event.type}`)!;
        return builtHandlers.get(name)!.call(element, event);
      },
    },
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  // linkedom doesn't run inline handlers; emulate `onload="tiny.runHandler(this,event)"`.
  const templateProto = Object.getPrototypeOf(
    document.createElement("template"),
  );
  const originalDispatch = templateProto.dispatchEvent;
  let dispatched = 0;
  templateProto.dispatchEvent = function (this: Element, event: Event) {
    dispatched++;
    if (this.hasAttribute(`tt-handler-${event.type}`)) {
      (globals.tiny as { runHandler: (e: Element, ev: Event) => unknown })
        .runHandler(this, event);
    }
    return true;
  };
  try {
    const update = document.createElement("update");
    update.innerHTML =
      '<template tt-handler-load="partialReplace" for-partial-id="list"><li>new</li></template><link rel="modulepreload"><script data-head></script>';
    const event = (paths?: string[]) =>
      new window.CustomEvent("incomingdata", {
        detail: { type: "html", element: update, paths },
      }) as Event;
    const routers = document.querySelectorAll("client-router");
    const cachedItems = (router = routers[0]) =>
      Array.from(
        router.querySelector<HTMLTemplateElement>("template")!.content.children,
      ).map((route: Element) =>
        (route.querySelector("template") as HTMLTemplateElement).content
          .querySelector("li")!.textContent
      );

    const patientFive = ["/patients/5", "/appointments/:date/5"];
    builtHandlers.get("updateCachedRoutes")!.call(
      routers[0],
      event(patientFive),
    );
    assertEquals(cachedItems(), ["new", "cached-6", "new"]);
    // Only the router the handler runs on is updated.
    assertEquals(cachedItems(routers[1]), ["other-5"]);

    // Partials for elements outside the cached content are skipped.
    const elsewhere = document.createElement("update");
    elsewhere.innerHTML =
      '<template tt-handler-load="partialReplace" for-partial-id="contact-list"><li>x</li></template>';
    dispatched = 0;
    builtHandlers.get("updateCachedRoutes")!.call(
      routers[0],
      new window.CustomEvent("incomingdata", {
        detail: { type: "html", element: elsewhere, paths: patientFive },
      }) as Event,
    );
    assertEquals(dispatched, 0);

    // Not on a matching page: head content is kept, the partial is dropped.
    builtHandlers.get("appendIncomingHtml")!.call(
      document.body,
      event(patientFive),
    );
    assertEquals(document.querySelector("#list li")!.textContent, "live");
    assertEquals(document.body.querySelectorAll(":scope > script").length, 1);
    assertEquals(
      document.body.querySelectorAll(":scope > template").length,
      0,
    );

    // On a matching page the partial is appended for normal live handling.
    location.pathname = "/patients/5";
    builtHandlers.get("appendIncomingHtml")!.call(
      document.body,
      event(patientFive),
    );
    assertEquals(
      document.body.querySelectorAll(":scope > template[for-partial-id]")
        .length,
      1,
    );
    // The source update element is untouched for other listeners.
    assertEquals(update.children.length, 3);

    // A region on the page can show content for a more specific path than
    // the URL (e.g. the default conversation on bare /messages).
    location.pathname = "/messages";
    document.getElementById("panel")!.insertAdjacentHTML(
      "beforeend",
      '<cache-collector><template><client-route update-path="/messages/61400"></client-route></template></cache-collector>',
    );
    const partialCount = () =>
      document.body.querySelectorAll(":scope > template[for-partial-id]")
        .length;
    builtHandlers.get("appendIncomingHtml")!.call(
      document.body,
      event(["/messages/61499"]),
    );
    assertEquals(partialCount(), 1);
    builtHandlers.get("appendIncomingHtml")!.call(
      document.body,
      event(["/messages/61400"]),
    );
    assertEquals(partialCount(), 2);
  } finally {
    templateProto.dispatchEvent = originalDispatch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
