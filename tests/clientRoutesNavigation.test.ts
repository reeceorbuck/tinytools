import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { handlers } from "../clientFunctions.ts";
import { ClientRoutes } from "../components/ClientRoutes.tsx";
import { navigationTools } from "../handlers/navigationTools.ts";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";
import { routeCacheTools } from "../handlers/routeCacheTools.ts";
import type { NavigationUrlResult } from "../handlers/navigationUrlTools.ts";

void ClientRoutes;
void navigationTools;
void partialInsertHandlers;
void routeCacheTools;

const moduleUrls = new Map<string, string>();
const builtHandlers = new Map<string, CallableFunction>();
for (
  const name of [
    "getNavigationMethod",
    "parseNavigationUrls",
    "getNavigationUrls",
    "processIncomingData",
    "performFetchAndUpdate",
    "partialReplace",
    "handleNavigate",
    "compileClientRoute",
    "interpolateClientRouteValue",
    "cloneClientRoute",
    "activateClientRoutes",
    "suspendClientRoutes",
    "observeRouteCache",
    "suspendRouteCache",
  ]
) {
  const entry = [...handlers.values()].find((handler) =>
    name === "partialReplace"
      ? handler.filename === partialInsertHandlers._handlerFilenames.get(name)
      : handler.fnName === name
  );
  assertExists(entry);
  let code = await entry.buildCode();
  if (
    ["handleNavigate", "partialReplace", "activateClientRoutes"].includes(name)
  ) {
    assertEquals(
      /routeCache|snapshotRoute|clientRoutePhases/.test(code),
      false,
    );
  }
  for (const [filename, url] of moduleUrls) {
    code = code.replaceAll(`"./${filename}.js"`, JSON.stringify(url));
  }
  const url = `data:text/javascript,${encodeURIComponent(code)}`;
  moduleUrls.set(entry.filename, url);
  builtHandlers.set(name, (await import(url)).default);
}

class SourceElement {
  partialAttributeReads = 0;

  constructor(
    private attributes: Record<string, string> = {},
    readonly form: SourceElement | null = null,
  ) {}

  getAttribute(name: string) {
    if (name === "data-nav-partial") this.partialAttributeReads++;
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string) {
    return Object.hasOwn(this.attributes, name);
  }
}

class FormElement extends SourceElement {
  get method() {
    return this.getAttribute("method") || "get";
  }
}
class ButtonElement extends SourceElement {}
class InputElement extends SourceElement {}

function createRoute(
  path: string,
  content: string,
  block = false,
  query?: string,
) {
  const route = document.createElement("client-route");
  route.setAttribute("path", path);
  if (block) route.setAttribute("data-nav-block", "");
  if (query !== undefined) route.setAttribute("query", query);
  const child = document.createElement("span");
  child.textContent = content;
  route.append(child);
  return route;
}

type Interception = {
  precommitHandler?: (
    controller: { redirect(url: string): void },
  ) => Promise<void>;
  handler?: () => Promise<void>;
};

class NavigationEvent extends Event {
  readonly interceptions: Interception[] = [];
  readonly destination: { url: string };
  canIntercept = true;
  navigationType = "push";
  info: unknown;
  formData: FormData | null = null;

  constructor(
    path: string,
    readonly sourceElement: SourceElement | null = null,
  ) {
    super("navigate", { cancelable: true });
    this.destination = { url: new URL(path, "https://example.com").href };
  }

  intercept(options: Interception) {
    this.interceptions.push(options);
  }
}

Deno.test("ClientRoutes cooperate with core navigation", async (test) => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function setGlobal(name: string, value: unknown) {
    if (!originals.has(name)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  function invoke(name: string, receiver: unknown) {
    const handler = builtHandlers.get(name);
    assertExists(handler);
    handler.call(receiver, new Event("load"));
  }
  function setup(coreFirst = true) {
    const navigation = new EventTarget();
    const location = { href: "https://example.com/current?keep=1" };
    const { document, Node, HTMLTemplateElement, MutationObserver } = parseHTML(
      "<!doctype html><html><body></body></html>",
    );
    const requests: {
      url: string;
      headers: Headers;
      method: string | undefined;
      body: unknown;
    }[] = [];
    const redirects: string[] = [];
    const styles = {
      get: (key: string) =>
        document.documentElement.style.getPropertyValue(key),
    };
    setGlobal("navigation", navigation);
    setGlobal("location", location);
    setGlobal("document", document);
    setGlobal("Node", Node);
    setGlobal("MutationObserver", MutationObserver);
    setGlobal("HTMLTemplateElement", HTMLTemplateElement);
    setGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
    setGlobal("fetch", (url: URL, init: RequestInit) => {
      requests.push({
        url: url.href,
        headers: new Headers(init.headers),
        method: init.method,
        body: init.body,
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    if (coreFirst) invoke("handleNavigate", {});
    function addRoutes(...routes: HTMLElement[]) {
      const template = document.createElement("template");
      template.content.append(...routes);
      document.head.append(template);
      invoke("activateClientRoutes", template);
      return template;
    }
    async function navigate(
      event: NavigationEvent,
      afterDispatch?: () => void,
    ) {
      navigation.dispatchEvent(event);
      afterDispatch?.();
      for (const interception of event.interceptions) {
        await interception.precommitHandler?.({
          redirect(url) {
            redirects.push(url);
          },
        });
      }
      location.href = redirects.at(-1) ?? event.destination.url;
      await Promise.all(
        event.interceptions.map((interception) => interception.handler?.()),
      );
    }
    return {
      addRoutes,
      navigate,
      get inserted() {
        return [...document.body.childNodes].map((node) => node.textContent);
      },
      requests,
      redirects,
      styles,
      location,
    };
  }

  setGlobal("HTMLFormElement", FormElement);
  setGlobal("HTMLButtonElement", ButtonElement);
  setGlobal("HTMLInputElement", InputElement);
  try {
    await test.step("disconnected containers neither render nor block fetch", async () => {
      const state = setup();
      const container = state.addRoutes(createRoute("/next", "detached", true));
      container.remove();
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.inserted, []);
      assertEquals(state.requests.length, 1);
    });

    await test.step("literal routes leave user text uninterpolated", async () => {
      const state = setup();
      const route = createRoute("/next", "$[value]", true);
      route.setAttribute("interpolate", "false");
      state.addRoutes(route);
      await state.navigate(new NavigationEvent("/next?value=replaced"));
      assertEquals(state.inserted, ["$[value]"]);
      assertEquals(state.requests.length, 0);
    });

    await test.step("authored once routes move their output and are consumed", async () => {
      const state = setup();
      const route = createRoute("/next", "Once $[value]", true);
      route.setAttribute("once", "");
      const output = route.firstElementChild!;
      let clicks = 0;
      output.addEventListener("click", () => clicks++);
      const container = state.addRoutes(route);
      await state.navigate(new NavigationEvent("/next?value=rendered"));
      assertStrictEquals(document.body.firstElementChild, output);
      assertEquals(output.textContent, "Once rendered");
      (output as HTMLElement).click();
      assertEquals(clicks, 1);
      assertEquals(container.content.children.length, 0);
      assertEquals(state.requests.length, 0);
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.requests.length, 1);
    });

    await test.step("POST routes interpolate submitted fields and retain the server request", async () => {
      const state = setup();
      const route = createRoute(
        "/send/:id",
        "$[id] $[pair-id] $[send-as] $[mode]",
      );
      route.setAttribute("method", "POST");
      route.firstElementChild!.setAttribute(
        "id",
        "communicator-item-$[pair-id]",
      );
      state.addRoutes(route, createRoute("/send/:id", "GET only", true));
      const formData = new FormData();
      formData.append("pair-id", "123");
      formData.append("send-as", "email");
      formData.append("mode", "confirmations");
      formData.append("mode", "ignored");
      formData.append("id", "form");
      const event = new NavigationEvent(
        "/send/path?id=query",
        new ButtonElement({}, new FormElement({ method: "post" })),
      );
      event.formData = formData;
      await state.navigate(event);
      assertEquals(state.inserted, ["form 123 email confirmations"]);
      assertEquals(
        document.body.firstElementChild!.id,
        "communicator-item-123",
      );
      assertEquals(state.requests.length, 1);
      assertEquals(state.requests[0].method, "post");
      assertEquals(state.requests[0].body, formData);
      assertEquals(route.textContent, "$[id] $[pair-id] $[send-as] $[mode]");
    });

    await test.step("submitter method overrides select the same route and fetch method", async () => {
      for (const method of ["get", "post"]) {
        const state = setup();
        const postRoute = createRoute("/send", "POST");
        postRoute.setAttribute("method", "post");
        state.addRoutes(createRoute("/send", "GET"), postRoute);
        const event = new NavigationEvent(
          "/send",
          new ButtonElement(
            { formmethod: method },
            new FormElement({ method: method === "get" ? "post" : "get" }),
          ),
        );
        event.formData = new FormData();
        await state.navigate(event);
        assertEquals(state.inserted, [method.toUpperCase()]);
        assertEquals(state.requests[0].method, method);
      }
    });

    for (const coreFirst of [true, false]) {
      await test.step(`observer captures on replacement and restores through normal routes; coreFirst=${coreFirst}`, async () => {
        const state = setup(coreFirst);
        const target = document.createElement("section");
        target.id = "source-panel";
        target.innerHTML =
          '<input value="initial"><textarea></textarea><button>$[literal]</button>';
        const input = target.querySelector("input") as HTMLInputElement;
        const textarea = target.querySelector(
          "textarea",
        ) as HTMLTextAreaElement;
        const button = target.querySelector("button")!;
        input.value = "edited";
        textarea.value = "notes";
        let clicks = 0;
        button.addEventListener("click", () => clicks++);
        document.body.append(target);
        const lifecycle = document.createElement("abortable-lifecycle-element");
        const watcher = document.createElement("template");
        watcher.setAttribute("cache-partial-id", "source-panel");
        watcher.innerHTML =
          '<client-route path="/current" once data-nav-block interpolate="false"><template for-partial-id="source-panel"></template></client-route><client-router for-partial-id="source-panel"><abortable-lifecycle-element><template></template></abortable-lifecycle-element></client-router>';
        lifecycle.append(watcher);
        target.append(lifecycle);
        invoke("observeRouteCache", watcher);
        const container = target.nextElementSibling!.querySelector("template")!;
        invoke("activateClientRoutes", container);
        const fallback = createRoute("/current", "loading");
        fallback.setAttribute("fallback", "");
        state.addRoutes(fallback);
        if (!coreFirst) invoke("handleNavigate", {});
        await state.navigate(new NavigationEvent("/next"));
        assertStrictEquals(target.querySelector("input"), input);
        assertEquals(container.content.children.length, 0);
        assertEquals(state.requests.length, 1);
        const replacement = document.createElement("template");
        replacement.setAttribute("for-partial-id", "source-panel");
        replacement.innerHTML = "<p>Other content</p>";
        invoke("partialReplace", replacement);
        await Promise.resolve();
        assertEquals(container.content.children.length, 1);
        await state.navigate(new NavigationEvent("/current?ignored=1"));
        const rendered = document.body.lastElementChild as HTMLTemplateElement;
        assertEquals(rendered.tagName, "TEMPLATE");
        assertEquals(container.content.children.length, 0);
        assertStrictEquals(rendered.content.querySelector("input"), input);
        assertStrictEquals(
          rendered.content.querySelector("textarea"),
          textarea,
        );
        assertStrictEquals(rendered.content.querySelector("button"), button);
        invoke("partialReplace", rendered);
        invoke("observeRouteCache", watcher);
        assertStrictEquals(target.querySelector("input"), input);
        assertEquals(input.value, "edited");
        assertEquals(textarea.value, "notes");
        assertEquals(button.textContent, "$[literal]");
        button.click();
        assertEquals(clicks, 1);
        input.value = "edited again";
        const secondReplacement = document.createElement("template");
        secondReplacement.setAttribute("for-partial-id", "source-panel");
        invoke("partialReplace", secondReplacement);
        await Promise.resolve();
        await state.navigate(new NavigationEvent("/current"));
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(target.querySelector("input"), input);
        assertEquals(input.value, "edited again");
        button.click();
        assertEquals(clicks, 2);
        assertEquals(document.querySelector("span"), null);
        assertEquals(state.requests.length, 1);
      });

      await test.step(`all containers render; coreFirst=${coreFirst}`, async () => {
        const state = setup(coreFirst);
        state.addRoutes(createRoute("/fragment", "first", true));
        state.addRoutes(createRoute("/fragment", "second"));
        if (!coreFirst) invoke("handleNavigate", {});
        const source = new ButtonElement(
          {},
          new FormElement({
            "data-nav-partial": "/fragment",
          }),
        );
        const event = new NavigationEvent("/next?empty=&value=2", source);
        await state.navigate(event);
        assertEquals(state.inserted, ["first", "second"]);
        assertEquals(state.requests, []);
        assertEquals(event.interceptions.length, 3);
        assertEquals(state.redirects, ["https://example.com/next?value=2"]);
        assertEquals(state.styles.get("--path-0"), "next");
        assertEquals(state.styles.get("--param-value"), "2");
        assertEquals(source.partialAttributeReads, 1);
      });
    }

    await test.step("URL snapshots are reused per event and isolated between events", () => {
      const state = setup();
      const getNavigationUrls = builtHandlers.get("getNavigationUrls");
      assertExists(getNavigationUrls);
      const attributes = { "data-nav-partial": "./fragment" };
      const source = new SourceElement(attributes);
      const event = new NavigationEvent("/next?empty=", source);
      const result = getNavigationUrls(event) as NavigationUrlResult;
      assertEquals(result.fromUrl.href, "https://example.com/current?keep=1");
      assertEquals(result.fetchUrl.href, "https://example.com/fragment?empty=");

      state.location.href = "https://example.com/changed";
      attributes["data-nav-partial"] = "/updated";
      event.info = { blockIntercept: true };
      const cached = getNavigationUrls(event) as NavigationUrlResult;
      assertEquals(cached === result, true);
      assertEquals(cached.shouldIntercept, true);
      assertEquals(cached.fromUrl.href, "https://example.com/current?keep=1");
      assertEquals(cached.fetchUrl.href, "https://example.com/fragment?empty=");
      assertEquals(source.partialAttributeReads, 1);

      const nextEvent = new NavigationEvent("/next?empty=", source);
      const next = getNavigationUrls(nextEvent) as NavigationUrlResult;
      assertEquals(next === result, false);
      assertEquals(next.fromUrl.href, "https://example.com/changed");
      assertEquals(next.fetchUrl.href, "https://example.com/updated?empty=");
      assertEquals(source.partialAttributeReads, 2);
      assertEquals(getNavigationUrls(event) === result, true);

      const blockedEvent = new NavigationEvent("/next?empty=", source);
      blockedEvent.info = { blockIntercept: true };
      const blocked = getNavigationUrls(blockedEvent) as NavigationUrlResult;
      assertEquals(blocked.shouldIntercept, false);
      assertEquals(getNavigationUrls(blockedEvent) === blocked, true);
      assertEquals(source.partialAttributeReads, 2);
    });

    await test.step("nonblocking matches render and fetch the partial URL", async () => {
      const state = setup();
      state.addRoutes(createRoute("/fragment", "loading"));
      const event = new NavigationEvent(
        "/next?empty=&value=2",
        new SourceElement({
          "data-nav-partial": "/fragment",
          "data-nav-redirect": "/saved",
        }),
      );
      await state.navigate(event);
      assertEquals(state.inserted, ["loading"]);
      assertEquals(state.requests.length, 1);
      assertEquals(
        state.requests[0].url,
        "https://example.com/fragment?empty=&value=2",
      );
      assertEquals(state.requests[0].headers.get("destination-url"), "/saved");
      assertEquals(
        state.requests[0].headers.get("source-url"),
        "/current?keep=1",
      );
      assertEquals(state.location.href, "https://example.com/saved");
    });

    await test.step("unmatched blocking routes do not suppress fetch", async () => {
      const state = setup();
      state.addRoutes(createRoute("/other", "unused", true));
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.inserted, []);
      assertEquals(state.requests.length, 1);
    });

    await test.step("blocked routes honor redirect true and custom redirect", async () => {
      for (const redirect of ["true", "/saved"]) {
        const state = setup();
        state.addRoutes(createRoute("/next", "local", true));
        await state.navigate(
          new NavigationEvent(
            "/next",
            new SourceElement({
              "data-nav-redirect": redirect,
            }),
          ),
        );
        assertEquals(state.requests, []);
        assertEquals(state.inserted, ["local"]);
        assertEquals(
          state.location.href,
          redirect === "true"
            ? "https://example.com/current?keep=1"
            : "https://example.com/saved",
        );
      }
    });

    await test.step("bypassed navigation leaves local content untouched", async () => {
      const events = [
        new NavigationEvent("https://other.com/next"),
        new NavigationEvent("/current?keep=1#section"),
        new NavigationEvent(
          "/next",
          new SourceElement({ "data-no-intercept": "" }),
        ),
        Object.assign(new NavigationEvent("/next"), {
          info: { blockIntercept: true },
        }),
        Object.assign(new NavigationEvent("/next"), {
          info: { onlyUpdateUrl: true },
        }),
        Object.assign(new NavigationEvent("/next"), { canIntercept: false }),
      ];
      const canceled = new NavigationEvent("/next");
      canceled.preventDefault();
      events.push(canceled);
      for (const event of events) {
        const state = setup();
        state.addRoutes(
          createRoute("/next", "local", true),
          createRoute("/current", "hash", true),
        );
        await state.navigate(event);
        assertEquals(state.inserted, []);
        assertEquals(state.requests, []);
        assertEquals(
          event.interceptions.length,
          (event.info as { onlyUpdateUrl?: boolean } | undefined)?.onlyUpdateUrl
            ? 1
            : 0,
        );
      }
    });

    await test.step("query matches gate blocking and render fresh URL values on every visit", async () => {
      const state = setup();
      const route = createRoute(
        "/patients/:id",
        "$[id]: $[name] $[missing]",
        true,
        "mode=edit&name=*",
      );
      route.firstElementChild!.setAttribute("data-name", "$[name]");
      state.addRoutes(route);
      await state.navigate(
        new NavigationEvent("/patients/42?mode=view&name=Ada"),
      );
      assertEquals(state.inserted, []);
      assertEquals(state.requests.length, 1);
      const value = `<img src=x onerror=alert(1)> $& $[id]`;
      await state.navigate(
        new NavigationEvent(
          `/patients/42?mode=edit&name=${encodeURIComponent(value)}`,
        ),
      );
      await state.navigate(
        new NavigationEvent("/patients/43?mode=edit&name=Grace"),
      );
      assertEquals(state.inserted, [`42: ${value} `, "43: Grace "]);
      assertEquals(state.requests.length, 1);
      assertEquals(
        document.body.firstElementChild!.getAttribute("data-name"),
        value,
      );
      assertEquals(document.body.querySelector("img"), null);
      assertEquals(route.textContent, "$[id]: $[name] $[missing]");
      assertEquals(
        route.firstElementChild!.getAttribute("data-name"),
        "$[name]",
      );
    });

    await test.step("empty query attributes reject nonempty queries", async () => {
      const state = setup();
      state.addRoutes(createRoute("/next", "empty", true, ""));
      await state.navigate(new NavigationEvent("/next?value="));
      assertEquals(state.inserted, []);
      assertEquals(state.requests.length, 1);
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.inserted, ["empty"]);
      assertEquals(state.requests.length, 1);
    });

    await test.step("partial fetch URLs supply captures and first query values", async () => {
      const state = setup();
      state.addRoutes(
        createRoute("/fragment/:id", "$[id] $[name]", true, "name=first"),
      );
      await state.navigate(
        new NavigationEvent(
          "/next?name=ignored",
          new SourceElement({
            "data-nav-partial":
              "/fragment/path?id=query&name=first&name=second",
          }),
        ),
      );
      assertEquals(state.inserted, ["query first"]);
      assertEquals(state.requests, []);
    });

    await test.step("clones preserve text nodes and interpolate nested template content once", async () => {
      const state = setup();
      const route = createRoute("/patients/:id", "", true);
      route.innerHTML =
        'Patient $[id]<!-- $[id] --><template><a href="/patients/$[id]" title="$[label]">$[label]</a></template>';
      state.addRoutes(route);
      await state.navigate(
        new NavigationEvent("/patients/42?label=%24%5Bid%5D"),
      );
      assertEquals(document.body.firstChild!.textContent, "Patient 42");
      assertEquals(document.body.childNodes[1].textContent, " $[id] ");
      const nested = document.body.querySelector("template")!;
      const anchor = nested.content.querySelector("a")!;
      assertEquals(anchor.getAttribute("href"), "/patients/42");
      assertEquals(anchor.getAttribute("title"), "$[id]");
      assertEquals(anchor.textContent, "$[id]");
      assertEquals(
        route.querySelector("template")!.content.querySelector("a")!
          .textContent,
        "$[label]",
      );
    });

    await test.step("invalid routes do not prevent valid siblings from matching", async () => {
      const state = setup();
      state.addRoutes(
        createRoute("/(", "invalid path", true),
        createRoute("/next", "invalid query", true, "name"),
        createRoute("/next", "valid", true),
      );
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.inserted, ["valid"]);
      assertEquals(state.requests, []);
    });

    await test.step("suspended routes stop blocking and can reactivate once", async () => {
      const state = setup();
      const template = state.addRoutes(
        createRoute("/next", "local", true),
      );
      invoke("suspendClientRoutes", template);
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.inserted, []);
      assertEquals(state.requests.length, 1);
      invoke("activateClientRoutes", template);
      invoke("activateClientRoutes", template);
      await state.navigate(new NavigationEvent("/next"));
      assertEquals(state.inserted, ["local"]);
      assertEquals(state.requests.length, 1);
      await state.navigate(new NavigationEvent("/elsewhere"));
      assertEquals(state.requests.length, 2);
    });
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
