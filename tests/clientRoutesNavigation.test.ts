import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { handlers } from "../clientFunctions.ts";
import { ClientRoutes } from "../components/ClientRoutes.tsx";
import { navigationTools } from "../handlers/navigationTools.ts";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";
import type { NavigationUrlResult } from "../handlers/navigationUrlTools.ts";

void ClientRoutes;
void navigationTools;
void partialInsertHandlers;

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
    const { document, Node, HTMLTemplateElement } = parseHTML(
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

    await test.step("source capture uses the route path and respects active ownership", async () => {
      const state = setup();
      const target = document.createElement("section");
      target.id = "source-panel";
      target.innerHTML = '<input value="current">';
      document.body.append(target);
      const route = document.createElement("client-route");
      route.setAttribute("path", "/source");
      route.setAttribute("from-partial-id", "source-panel");
      const insertion = document.createElement("template");
      insertion.setAttribute("for-partial-id", "source-panel");
      route.append(insertion);
      state.addRoutes(route);
      await state.navigate(new NavigationEvent("/other"));
      assertEquals(insertion.content.childNodes.length, 0);
      state.location.href = "https://example.com/source";
      await state.navigate(new NavigationEvent("/other"));
      assertEquals(target.childNodes.length, 0);
      assertEquals(
        insertion.content.querySelector("input")!.getAttribute("value"),
        "current",
      );
      target.innerHTML = '<input value="unrelated">';
      const marker = document.createElement("template");
      marker.setAttribute("data-client-route-active-path", "/different");
      target.append(marker);
      (target.querySelector("input") as HTMLInputElement).value = "unrelated";
      state.location.href = "https://example.com/source";
      await state.navigate(new NavigationEvent("/other"));
      assertEquals(
        insertion.content.querySelector("input")!.getAttribute("value"),
        "current",
      );
    });

    for (const outerFirst of [true, false]) {
      await test.step(`destination scopes retain and restore the correct panel; outerFirst=${outerFirst}`, async () => {
        const state = setup();
        state.location.href = "https://example.com/trial/a";
        const outer = document.createElement("section");
        outer.id = "outer";
        outer.innerHTML =
          '<input id="notes"><section id="inner"><input id="input-a"><template data-client-route-active-path="/trial/a"></template></section><template data-client-route-active-path="/trial{/:page}?"></template>';
        document.body.append(outer);
        const notes = outer.querySelector("#notes")!;
        const inner = outer.querySelector("#inner")!;
        const inputA = inner.querySelector("input")!;
        const cachedRoute = (path: string, partialId: string) => {
          const route = document.createElement("client-route");
          route.setAttribute("path", path);
          route.setAttribute("from-partial-id", partialId);
          route.setAttribute("data-nav-block", "");
          const insertion = document.createElement("template");
          insertion.setAttribute("for-partial-id", partialId);
          route.append(insertion);
          return route;
        };
        const outerRoute = cachedRoute("/trial{/:page}?", "outer");
        const routeA = cachedRoute("/trial/a", "inner");
        const routeB = cachedRoute("/trial/b", "inner");
        const inputB = document.createElement("input");
        const markerB = document.createElement("template");
        markerB.setAttribute("data-client-route-active-path", "/trial/b");
        routeB.querySelector("template")!.content.append(inputB, markerB);
        if (outerFirst) state.addRoutes(outerRoute);
        const childRouter = state.addRoutes(routeA);
        const childContainer = document.createElement("client-router");
        childContainer.append(childRouter);
        outer.append(childContainer);
        if (!outerFirst) state.addRoutes(outerRoute);

        await state.navigate(new NavigationEvent("/trial/b"));
        assertStrictEquals(outer.querySelector("#notes"), notes);
        assertStrictEquals(outer.querySelector("#inner"), inner);
        assertEquals(inner.childNodes.length, 0);
        assertEquals(state.requests.length, 1);
        inner.append(
          ...Array.from(routeB.querySelector("template")!.content.childNodes),
        );
        childRouter.content.append(routeB);
        assertStrictEquals(inner.querySelector("input"), inputB);

        await state.navigate(new NavigationEvent("/elsewhere"));
        assertEquals(outer.childNodes.length, 0);
        assertStrictEquals(inner.querySelector("input"), inputB);
        assertEquals(state.requests.length, 2);
        if (outerFirst) invoke("suspendClientRoutes", childRouter);

        await state.navigate(new NavigationEvent("/trial/a"));
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(outer.querySelector("#notes"), notes);
        assertStrictEquals(outer.querySelector("#inner"), inner);
        invoke("activateClientRoutes", childRouter);
        invoke("activateClientRoutes", childRouter);
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(inner.querySelector("input"), inputA);
        await state.navigate(new NavigationEvent("/trial/b"));
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(inner.querySelector("input"), inputB);
        assertEquals(state.requests.length, 2);
        await state.navigate(new NavigationEvent("/elsewhere"));
        routeA.remove();
        await state.navigate(new NavigationEvent("/trial/a"));
        assertEquals(outer.childNodes.length, 0);
        assertEquals(state.requests.length, 4);
      });
    }

    for (const parentPath of ["/trial", "/trial/"]) {
      await test.step(`exact parent remains mounted throughout descendants: ${parentPath}`, async () => {
        const state = setup();
        state.location.href = `https://example.com${parentPath}`;
        const target = document.createElement("section");
        target.id = "parent";
        const input = document.createElement("input");
        const marker = document.createElement("template");
        marker.setAttribute("data-client-route-active-path", parentPath);
        target.append(input, marker);
        document.body.append(target);
        const route = document.createElement("client-route");
        route.setAttribute("path", parentPath);
        route.setAttribute("from-partial-id", "parent");
        route.setAttribute("data-nav-block", "");
        const insertion = document.createElement("template");
        insertion.setAttribute("for-partial-id", "parent");
        route.append(insertion);
        state.addRoutes(route);
        for (
          const destination of [
            "/trial/a",
            "/trial/a/deeper",
            "/trial/b?mode=edit",
          ]
        ) {
          await state.navigate(new NavigationEvent(destination));
          assertStrictEquals(target.firstChild, input);
          assertEquals(insertion.content.childNodes.length, 0);
        }
        assertEquals(state.requests.length, 3);
        await state.navigate(new NavigationEvent("/trial-other"));
        assertEquals(target.childNodes.length, 0);
        assertStrictEquals(insertion.content.firstChild, input);
        assertEquals(state.requests.length, 4);
        await state.navigate(new NavigationEvent(parentPath));
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(target.firstChild, input);
        assertEquals(state.requests.length, 4);
      });
    }

    await test.step("moving the active marker does not overwrite another cached route", async () => {
      const state = setup();
      const target = document.createElement("section");
      target.id = "panel";
      target.innerHTML =
        '<input value="A"><template data-client-route-active-path="/current"></template>';
      const inputA = target.querySelector("input")!;
      document.body.append(target);
      const routeA = document.createElement("client-route");
      routeA.setAttribute("path", "/current");
      routeA.setAttribute("from-path", "*");
      routeA.setAttribute("from-partial-id", "panel");
      routeA.setAttribute("data-nav-block", "");
      routeA.innerHTML = '<template for-partial-id="panel"></template>';
      const routeB = routeA.cloneNode(true) as HTMLElement;
      routeB.setAttribute("path", "/next");
      const insertionB = routeB.querySelector("template")!;
      const inputB = document.createElement("input");
      inputB.value = "B";
      const markerB = document.createElement("template");
      markerB.setAttribute("data-client-route-active-path", "/next");
      insertionB.content.append(inputB, markerB);
      state.addRoutes(routeA, routeB);
      for (const path of ["/next", "/current", "/next", "/current"]) {
        await state.navigate(new NavigationEvent(path));
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(
          target.querySelector("input"),
          path === "/next" ? inputB : inputA,
        );
      }
      assertEquals(state.requests.length, 0);
    });

    for (const coreFirst of [true, false]) {
      await test.step(`dynamic routes capture source before rendering; coreFirst=${coreFirst}`, async () => {
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
        const destination = document.createElement("client-route");
        destination.setAttribute("path", "/next");
        destination.setAttribute("from-path", "/current");
        destination.setAttribute("from-partial-id", "source-panel");
        destination.setAttribute("data-nav-block", "");
        const insertion = document.createElement("template");
        insertion.setAttribute("for-partial-id", "source-panel");
        destination.append(insertion);
        const container = state.addRoutes();
        container.content.append(destination);
        const fallback = createRoute("/next", "loading");
        fallback.setAttribute("fallback", "");
        state.addRoutes(fallback);
        const append = document.body.append.bind(document.body);
        let capturedBeforeRender = false;
        document.body.append = (...nodes) => {
          capturedBeforeRender = target.childNodes.length === 0 &&
            insertion.content.childNodes.length === 0;
          append(...nodes);
        };
        if (!coreFirst) invoke("handleNavigate", {});
        const event = new NavigationEvent("/next?ignored=1");
        await state.navigate(event, () => {
          assertStrictEquals(insertion.content.querySelector("input"), input);
          assertEquals(target.childNodes.length, 0);
          assertEquals(document.body.children.length, 1);
          assertEquals(capturedBeforeRender, false);
          assertEquals(state.requests.length, 0);
          assertEquals(
            event.interceptions.filter((entry) => entry.precommitHandler)
              .length,
            1,
          );
        });
        const rendered = document.body.lastElementChild as HTMLTemplateElement;
        assertEquals(rendered.tagName, "TEMPLATE");
        assertEquals(capturedBeforeRender, true);
        assertEquals(insertion.content.childNodes.length, 0);
        assertStrictEquals(rendered.content.querySelector("input"), input);
        assertStrictEquals(
          rendered.content.querySelector("textarea"),
          textarea,
        );
        assertStrictEquals(rendered.content.querySelector("button"), button);
        invoke("partialReplace", rendered);
        assertStrictEquals(target.querySelector("input"), input);
        assertEquals(input.value, "edited");
        assertEquals(textarea.value, "notes");
        assertEquals(button.textContent, "$[literal]");
        button.click();
        assertEquals(clicks, 1);
        input.value = "edited again";
        state.location.href = "https://example.com/current";
        await state.navigate(new NavigationEvent("/next"));
        invoke("partialReplace", document.body.lastElementChild);
        assertStrictEquals(target.querySelector("input"), input);
        assertEquals(input.value, "edited again");
        button.click();
        assertEquals(clicks, 2);
        assertEquals(document.querySelector("span"), null);
        assertEquals(state.requests.length, 0);
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
