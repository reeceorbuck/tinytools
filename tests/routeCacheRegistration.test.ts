import { assertEquals, assertExists } from "@std/assert";
import { parseHTML } from "linkedom";
import { handlers } from "../clientFunctions.ts";
import { routeCacheTools } from "../handlers/routeCacheTools.ts";

void routeCacheTools;
const builtHandlers = new Map<string, CallableFunction>();
for (const name of ["registerRouteCache"]) {
  const entry = [...handlers.values()].find((handler) =>
    handler.fnName === name
  );
  assertExists(entry);
  const code = await entry.buildCode();
  builtHandlers.set(
    name,
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default,
  );
}

Deno.test("cache registration creates or reuses sibling ClientRoutes", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const { document } = parseHTML(
    '<html><body><div id="parent"><section id="panel"><input><textarea></textarea></section></div></body></html>',
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  try {
    const target = document.getElementById("panel")!;
    const register = (path: string) => {
      const wrapper = document.createElement("template");
      wrapper.setAttribute("for-partial-id", "panel");
      wrapper.setAttribute("path", path);
      wrapper.innerHTML =
        `<client-route path="${path}" data-nav-block from-partial-id="panel"><template for-partial-id="panel"></template></client-route><client-router hidden><abortable-lifecycle-element><template></template></abortable-lifecycle-element></client-router>`;
      target.append(wrapper);
      builtHandlers.get("registerRouteCache")!.call(wrapper);
      const router = target.nextElementSibling!;
      const template = router.querySelector("template") as HTMLTemplateElement;
      const route = Array.from(template.content.children).find((route) =>
        route.getAttribute("path") === path
      )!;
      return { router, template, route };
    };
    const first = register("/a");
    assertEquals(first.router.tagName, "CLIENT-ROUTER");
    const input = target.querySelector("input") as HTMLInputElement;
    input.value = "edited A";
    assertEquals(
      target.querySelector("template[data-client-route-active-path]")!
        .getAttribute("data-client-route-active-path"),
      "/a",
    );
    assertEquals(target.querySelector("input") === input, true);

    const second = register("/b");
    assertEquals(second.router === first.router, true);
    assertEquals(first.template.content.children.length, 2);
    assertEquals(
      target.querySelectorAll("template[data-client-route-active-path]").length,
      1,
    );
    assertEquals(
      target.querySelector("template[data-client-route-active-path]")!
        .getAttribute("data-client-route-active-path"),
      "/b",
    );
    const replacement = register("/a");
    assertEquals(replacement.router === first.router, true);
    assertEquals(first.template.content.children.length, 2);
    assertEquals(first.route.parentNode, null);

    assertEquals(first.router.parentElement === target.parentElement, true);
    assertEquals(document.querySelectorAll("client-router").length, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
