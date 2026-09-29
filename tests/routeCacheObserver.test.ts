import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { handlers } from "../clientFunctions.ts";
import { routeCacheTools } from "../handlers/routeCacheTools.ts";

void routeCacheTools;
const builtHandlers = new Map<
  string,
  (this: unknown, ...args: unknown[]) => unknown
>();
for (const name of ["observeRouteCache"]) {
  const entry = [...handlers.values()].find((handler) =>
    handler.fnName === name
  );
  assertExists(entry);
  const code = await entry.buildCode();
  assertEquals(/navigation|navigate/.test(code), false);
  builtHandlers.set(
    name,
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default,
  );
}

Deno.test("cache observer captures replacements without navigation", async () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const { document, MutationObserver } = parseHTML(
    '<html><body><main><section id="panel"><input><textarea></textarea></section></main></body></html>',
  );
  for (const [name, value] of Object.entries({ document, MutationObserver })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  try {
    const target = document.getElementById("panel")!;
    const watcher = Object.assign(document.createElement("cache-collector"), {
      abortController: new AbortController(),
    });
    watcher.setAttribute("cache-partial-id", "panel");
    watcher.innerHTML =
      '<template><client-route path="/a" once data-nav-block interpolate="false"><template for-partial-id="panel"></template><link rel="modulepreload"></client-route><client-router cache-owner-id="panel"><template></template></client-router></template>';
    target.append(watcher);
    const observe = () => {
      watcher.abortController = new AbortController();
      builtHandlers.get("observeRouteCache")!.call(watcher);
    };
    const suspend = () => watcher.abortController.abort();
    observe();
    const routes = target.nextElementSibling!.querySelector("template")!;
    assertEquals(routes.content.children.length, 0);
    const input = target.querySelector("input")!;
    input.value = "edited";
    let clicks = 0;
    input.addEventListener("click", () => clicks++);
    input.setAttribute("data-edit", "yes");
    await Promise.resolve();
    assertEquals(routes.content.children.length, 0);
    const extra = document.createElement("input");
    extra.value = "added immediately before replacement";
    target.insertBefore(extra, watcher);
    const originalNodes = Array.from(target.childNodes);
    target.replaceChildren(document.createElement("p"));
    await Promise.resolve();
    const route = routes.content.firstElementChild!;
    assertExists(route);
    const insertion = route.querySelector("template")!;
    assertEquals(insertion.content.childNodes.length, originalNodes.length);
    originalNodes.forEach((node, index) =>
      assertStrictEquals(insertion.content.childNodes[index], node)
    );
    assertStrictEquals(insertion.content.querySelector("input"), input);
    assertEquals(input.value, "edited");
    input.click();
    assertEquals(clicks, 1);
    assertEquals(target.firstElementChild!.tagName, "P");
    suspend();
    assertEquals(routes.content.children.length, 1);

    target.replaceChildren(...Array.from(insertion.content.childNodes));
    route.remove();
    observe();
    target.replaceChildren(document.createElement("article"));
    suspend();
    assertEquals(routes.content.children.length, 1);
    const second = routes.content.firstElementChild!.querySelector("template")!;
    assertStrictEquals(second.content.querySelector("input"), input);

    target.replaceChildren(...Array.from(second.content.childNodes));
    routes.content.replaceChildren();
    observe();
    const parent = target.parentElement!;
    parent.remove();
    suspend();
    assertEquals(routes.content.children.length, 0);
    assertStrictEquals(target.querySelector("input"), input);
    document.body.append(parent);
    observe();
    target.replaceChildren();
    await Promise.resolve();
    assertEquals(routes.content.children.length, 1);
    suspend();

    const parentRoute = routes.content.firstElementChild!;
    target.replaceChildren(
      ...Array.from(parentRoute.querySelector("template")!.content.childNodes),
    );
    parentRoute.remove();
    observe();
    const inner = document.createElement("section");
    inner.id = "inner";
    const innerInput = document.createElement("input");
    innerInput.value = "nested state";
    const innerWatcher = Object.assign(
      document.createElement("cache-collector"),
      {
        abortController: new AbortController(),
      },
    );
    innerWatcher.setAttribute("cache-partial-id", "inner");
    innerWatcher.innerHTML =
      '<template><client-route path="/a/child" once data-nav-block interpolate="false"><template for-partial-id="inner"></template></client-route><client-router cache-owner-id="inner"><template></template></client-router></template>';
    inner.append(innerInput, innerWatcher);
    target.append(inner);
    builtHandlers.get("observeRouteCache")!.call(innerWatcher);
    const innerRoutes = inner.nextElementSibling!.querySelector("template")!;
    await Promise.resolve();
    inner.replaceChildren(document.createElement("p"));
    await Promise.resolve();
    assertEquals(routes.content.children.length, 0);
    assertEquals(innerRoutes.content.children.length, 1);
    const innerRoute = innerRoutes.content.firstElementChild!;
    inner.replaceChildren(
      ...Array.from(innerRoute.querySelector("template")!.content.childNodes),
    );
    innerRoute.remove();
    builtHandlers.get("observeRouteCache")!.call(innerWatcher);
    target.replaceChildren(document.createElement("article"));
    innerWatcher.abortController.abort();
    suspend();
    assertEquals(innerRoutes.content.children.length, 0);
    assertStrictEquals(inner.querySelector("input"), innerInput);
    assertEquals(routes.content.children.length, 1);
    const savedParent = routes.content.firstElementChild!;
    target.replaceChildren(
      ...Array.from(savedParent.querySelector("template")!.content.childNodes),
    );
    savedParent.remove();
    observe();
    innerWatcher.abortController = new AbortController();
    builtHandlers.get("observeRouteCache")!.call(innerWatcher);
    inner.replaceChildren();
    await Promise.resolve();
    assertEquals(routes.content.children.length, 0);
    assertEquals(innerRoutes.content.children.length, 1);
    assertStrictEquals(
      innerRoutes.content.firstElementChild!.querySelector("template")!.content
        .querySelector("input"),
      innerInput,
    );
    suspend();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
