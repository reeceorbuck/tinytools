import { assertEquals } from "@std/assert";
import { ClientTools } from "../clientTools.ts";
import {
  css,
  mergeClassNames,
  SCOPE_BOUNDARY_CLASS,
  scopedTo,
  setCustomScope,
  unscoped,
} from "../scopedStyles.ts";

Deno.test("scoped styles - plain css uses boundary default", () => {
  const tools = new ClientTools("file:///tests/scoped-default.ts", {
    styles: {
      panel: css`
        color: red;
      `,
    },
  });

  const style = tools._styles.get("panel");
  const content = style?.buildCssContent() ?? "";
  assertEquals(content.includes("@layer normal"), true);
  assertEquals(content.includes(`.${SCOPE_BOUNDARY_CLASS}`), true);
  assertEquals(content.includes('[data-scope-boundary~="panel_'), true);
  assertEquals(content.includes('[data-scope-boundary~="global"]'), true);
});

Deno.test("scoped styles - setCustomScope.toBoundary uses boundary end", () => {
  const tools = new ClientTools("file:///tests/scoped-boundary.ts", {
    styles: {
      panel: setCustomScope.toBoundary(css`
        color: red;
      `),
    },
  });

  const style = tools._styles.get("panel");
  const content = style?.buildCssContent() ?? "";
  assertEquals(content.includes("@layer normal"), true);
  assertEquals(content.includes(`.${SCOPE_BOUNDARY_CLASS}`), true);
  assertEquals(content.includes('[data-scope-boundary~="panel_'), true);
  assertEquals(content.includes('[data-scope-boundary~="global"]'), true);
});

Deno.test("scoped styles - scopedTo uses custom selectors", () => {
  const tools = new ClientTools("file:///tests/scoped-to.ts", {
    styles: {
      panel: scopedTo(
        css`
          color: red;
        `,
        [".break", "[data-stop]"],
      ),
    },
  });

  const style = tools._styles.get("panel");
  const content = style?.buildCssContent() ?? "";
  assertEquals(content.includes("@layer limited"), true);
  assertEquals(
    content.includes('to (.break, [data-stop], [data-scope-boundary~="panel_'),
    true,
  );
  assertEquals(
    content.includes('[data-scope-boundary~="global"])'),
    true,
  );
});

Deno.test("scoped styles - scopedTo supports child selectors directly", () => {
  const tools = new ClientTools(
    "file:///tests/scoped-to-children-with-selector.ts",
    {
      styles: {
        panel: scopedTo(
          css`
            color: red;
          `,
          [".break>*", "[data-stop]>*"],
        ),
      },
    },
  );

  const style = tools._styles.get("panel");
  const content = style?.buildCssContent() ?? "";
  assertEquals(content.includes("@layer limited"), true);
  assertEquals(
    content.includes(
      'to (.break>*, [data-stop]>*, [data-scope-boundary~="panel_',
    ),
    true,
  );
  assertEquals(
    content.includes('[data-scope-boundary~="global"])'),
    true,
  );
});

Deno.test("scoped styles - global token boundary is exact", () => {
  const tools = new ClientTools("file:///tests/scoped-global-token.ts", {
    styles: {
      panel: css`
        color: red;
      `,
    },
  });

  const style = tools._styles.get("panel");
  const content = style?.buildCssContent() ?? "";
  assertEquals(content.includes('[data-scope-boundary~="global"]'), true);
  assertEquals(content.includes('[data-scope-boundary*="global"]'), false);
});

Deno.test("scoped styles - ClientTools.generatedStyleNames exposes generated class string", () => {
  const tools = new ClientTools("file:///tests/scoped-styled-accessor.ts", {
    styles: {
      panel: css`
        color: red;
      `,
    },
  });

  const className = tools.generatedStyleNames.get("panel") ?? "";
  assertEquals(className.includes("panel_"), true);
  assertEquals(className.includes("scopeBoundary"), false);
});

Deno.test("scoped styles - unscoped uses explicit data boundary tokens", () => {
  const tools = new ClientTools("file:///tests/scoped-none.ts", {
    styles: {
      panel: unscoped(css`
        color: red;
      `),
    },
  });

  const style = tools._styles.get("panel");
  const content = style?.buildCssContent() ?? "";
  assertEquals(content.includes("@layer unscoped"), true);
  assertEquals(content.includes("@scope (."), true);
  assertEquals(content.includes(" to ("), true);
  assertEquals(content.includes('[data-scope-boundary~="panel_'), true);
  assertEquals(content.includes('[data-scope-boundary~="global"]'), true);
  assertEquals(content.includes(".scopeBoundary"), false);
});

Deno.test("scoped styles - setCustomScope methods accept custom layer", () => {
  const tools = new ClientTools("file:///tests/scoped-custom-layer.ts", {
    styles: {
      selectorsLayer: setCustomScope.toSelectors(
        css`
          color: red;
        `,
        [".break"],
        { layer: "debug" },
      ),
      boundaryLayer: setCustomScope.toBoundary(
        css`
          color: blue;
        `,
        { layer: "important" },
      ),
      unscopedLayer: setCustomScope.unscoped(
        css`
          color: green;
        `,
        { layer: "limited" },
      ),
    },
  });

  const selectorsCss = tools._styles.get("selectorsLayer")?.buildCssContent() ??
    "";
  const boundaryCss = tools._styles.get("boundaryLayer")?.buildCssContent() ??
    "";
  const unscopedCss = tools._styles.get("unscopedLayer")?.buildCssContent() ??
    "";

  assertEquals(selectorsCss.includes("@layer debug"), true);
  assertEquals(boundaryCss.includes("@layer important"), true);
  assertEquals(unscopedCss.includes("@layer limited"), true);
});

Deno.test("scoped styles - globalStyles default to global layer", () => {
  const tools = new ClientTools("file:///tests/scoped-global-layer.ts", {
    globalStyles: {
      reset: css`
        body {
          margin: 0;
        }
      `,
    },
  });

  const globalCss = tools.globalStyles[0]?.buildCssContent() ?? "";
  assertEquals(globalCss.includes("@layer global"), true);
  assertEquals(globalCss.includes("@scope"), false);
});

Deno.test("scoped styles - mergeClassNames dedupes repeated classes", () => {
  assertEquals(
    mergeClassNames("layout_123 sb", "test_456 sb", "extra", ""),
    "layout_123 sb test_456 extra",
  );
});

Deno.test("scoped styles - mergeClassNames ignores falsy values", () => {
  assertEquals(
    mergeClassNames("layout_123", undefined, false, null, "test_456"),
    "layout_123 test_456",
  );
});
