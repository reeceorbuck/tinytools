import { assertEquals, assertExists } from "@std/assert";
import { handlers } from "../clientFunctions.ts";
import { navigationUrlTools } from "../handlers/navigationUrlTools.ts";

void navigationUrlTools;
const entry = [...handlers.values()].find((handler) =>
  handler.fnName === "parseNavigationUrls"
);
assertExists(entry);
const { default: parseNavigationUrls } = await import(
  `data:text/javascript,${encodeURIComponent(await entry.buildCode())}`
) as {
  default: typeof navigationUrlTools.getFunctionReferences.parseNavigationUrls;
};

class SourceElement {
  constructor(
    private attributes: Record<string, string> = {},
    readonly form: SourceElement | null = null,
  ) {}

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string) {
    return Object.hasOwn(this.attributes, name);
  }
}

class FormElement extends SourceElement {}

function parse(
  destination: string,
  source: SourceElement | null = null,
  navigationType: NavigationType = "push",
  blockIntercept = false,
) {
  return parseNavigationUrls(
    {
      destination: { url: destination } as NavigationDestination,
      sourceElement: source as unknown as HTMLElement | null,
      navigationType,
    },
    "https://example.com/current/page?keep=1",
    blockIntercept,
  );
}

Deno.test("navigation URL resolution", async (test) => {
  const previousFormElement = Object.getOwnPropertyDescriptor(
    globalThis,
    "HTMLFormElement",
  );
  Object.defineProperty(globalThis, "HTMLFormElement", {
    configurable: true,
    value: FormElement,
  });

  try {
    await test.step("cleaning changes only the display URL", () => {
      const destination = "https://example.com/next?empty=&keep=2";
      const result = parse(destination);
      assertEquals(
        result.fromUrl.href,
        "https://example.com/current/page?keep=1",
      );
      assertEquals(result.toUrl.href, destination);
      assertEquals(result.fetchUrl.href, destination);
      assertEquals(result.displayUrl.href, "https://example.com/next?keep=2");
      assertEquals(result.shouldRedirect, true);
      assertEquals(result.shouldIntercept, true);
      assertEquals(
        parse("https://example.com/next?keep=2").shouldRedirect,
        false,
      );
    });

    await test.step("partial URLs inherit destination parameters", () => {
      const form = new FormElement({ "data-nav-partial": "./fragment#body" });
      const result = parse("https://example.com/next?empty=&keep=2", form);
      assertEquals(
        result.fetchUrl.href,
        "https://example.com/fragment?empty=&keep=2#body",
      );
      assertEquals(result.displayUrl.href, "https://example.com/next?keep=2");
    });

    await test.step("submitter partial URL overrides form and keeps its query", () => {
      const form = new FormElement({ "data-nav-partial": "/form" });
      const submitter = new SourceElement({
        "data-nav-partial": "/button?own=1",
      }, form);
      const result = parse("https://example.com/next?keep=2", submitter);
      assertEquals(result.fetchUrl.href, "https://example.com/button?own=1");
      assertEquals(
        parse("https://example.com/next", new SourceElement({}, form)).fetchUrl
          .pathname,
        "/form",
      );
      assertEquals(
        parse(
          "https://example.com/next",
          new SourceElement({ "data-nav-partial": "" }, form),
        ).fetchUrl.pathname,
        "/next",
      );
    });

    await test.step("redirect true keeps current URL without changing fetch", () => {
      const form = new FormElement({
        "data-nav-partial": "/fragment",
        "data-nav-redirect": "true",
      });
      const result = parse(
        "https://example.com/next?empty=&keep=2",
        new SourceElement({}, form),
      );
      assertEquals(result.displayUrl.href, result.fromUrl.href);
      assertEquals(
        result.fetchUrl.href,
        "https://example.com/fragment?empty=&keep=2",
      );
      assertEquals(result.shouldRedirect, true);
    });

    await test.step("custom and empty submitter redirects override the form", () => {
      const form = new FormElement({ "data-nav-redirect": "true" });
      const result = parse(
        "https://example.com/next?empty=",
        new SourceElement({ "data-nav-redirect": "./saved?empty=" }, form),
      );
      assertEquals(
        result.displayUrl.href,
        "https://example.com/current/saved?empty=",
      );
      assertEquals(result.fetchUrl.href, "https://example.com/next?empty=");
      assertEquals(result.shouldRedirect, true);
      const disabled = parse(
        "https://example.com/next",
        new SourceElement({ "data-nav-redirect": "" }, form),
      );
      assertEquals(disabled.displayUrl.href, "https://example.com/next");
      assertEquals(disabled.shouldRedirect, false);
    });

    await test.step("non-push navigation retains query and ignores redirects", () => {
      for (const navigationType of ["replace", "reload", "traverse"] as const) {
        const result = parse(
          "https://example.com/next?empty=",
          new SourceElement({ "data-nav-redirect": "true" }),
          navigationType,
        );
        assertEquals(result.displayUrl.href, "https://example.com/next?empty=");
        assertEquals(result.shouldRedirect, false);
      }
    });

    await test.step("native navigation bypasses attribute parsing", () => {
      const invalidPartial = new SourceElement({
        "data-nav-partial": "http://[",
      });
      const hash = parse(
        "https://example.com/current/page/?keep=1#section",
        invalidPartial,
      );
      assertEquals(hash.isSameDocumentHashNavigation, true);
      assertEquals(hash.shouldIntercept, false);
      assertEquals(
        parse("https://other.com/", invalidPartial).shouldIntercept,
        false,
      );
      assertEquals(
        parse("https://example.com/next", invalidPartial, "push", true)
          .shouldIntercept,
        false,
      );
      assertEquals(
        parse(
          "https://example.com/next",
          new SourceElement({
            "data-no-intercept": "",
            "data-nav-partial": "http://[",
          }),
        ).shouldIntercept,
        false,
      );
    });

    await test.step("invalid redirect keeps the fetch and cleaned display URL", () => {
      const result = parse(
        "https://example.com/next?empty=",
        new SourceElement({ "data-nav-redirect": "http://[" }),
      );
      assertEquals(result.fetchUrl.href, "https://example.com/next?empty=");
      assertEquals(result.displayUrl.href, "https://example.com/next");
      assertEquals(result.shouldRedirect, true);
    });
  } finally {
    if (previousFormElement) {
      Object.defineProperty(globalThis, "HTMLFormElement", previousFormElement);
    } else {
      Reflect.deleteProperty(globalThis, "HTMLFormElement");
    }
  }
});
