import { assertEquals } from "@std/assert";
import { Handlers, imports, Styles } from "../clientTools.ts";
import { css } from "../scopedStyles.ts";

Deno.test("split tools api - css tag trims formatting whitespace", () => {
  const inlineStyle = css`
    --isSelected: if(
      style(--selectedMode: original): 1;
      else: 0;
    );
  `;

  assertEquals(
    inlineStyle,
    "--isSelected: if( style(--selectedMode: original): 1; else: 0; );",
  );
});

Deno.test({
  name: "split tools api - styles engage through imports helper",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const styles = new Styles("file:///tests/split-styles.ts", {
      panel: css`
        color: red;
      `,
    });

    const { styled } = await imports(styles);
    assertEquals(styled.panel.includes("panel_"), true);
  },
});

Deno.test("split tools api - global styles use global option", () => {
  const styles = new Styles("file:///tests/split-global.ts", {
    reset: css`
      body {
        margin: 0;
      }
    `,
  }, { global: true });

  const globalCss = styles.globalStyles[0]?.buildCssContent() ?? "";
  assertEquals(styles.globalStyles.length, 1);
  assertEquals(globalCss.includes("@layer global"), true);
  assertEquals(globalCss.includes("@scope"), false);
});

Deno.test({
  name: "split tools api - handlers can import other handlers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sharedHandlers = new Handlers("file:///tests/shared-handlers.ts", {
      sharedHandler: function () {
        return "shared";
      },
    });

    const localHandlers = new Handlers("file:///tests/local-handlers.ts", {
      localHandler: function () {
        return "local";
      },
    }, {
      imports: [sharedHandlers],
    });

    const { fn } = await imports(localHandlers);
    assertEquals(String(fn.sharedHandler).includes("handlers."), true);
    assertEquals(String(fn.localHandler).includes("handlers."), true);
  },
});

Deno.test({
  name: "split tools api - imports helper merges handlers and styles",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const styles = new Styles("file:///tests/split-mixed-styles.ts", {
      button: css`
        color: white;
      `,
    });

    const handlers = new Handlers("file:///tests/split-mixed-handlers.ts", {
      clickHandler: function () {
        return "clicked";
      },
    });

    const { fn, styled } = await imports(styles, handlers);
    assertEquals(String(fn.clickHandler).includes("handlers."), true);
    assertEquals(styled.button.includes("button_"), true);
  },
});

Deno.test({
  name: "split tools api - styles can import other styles as a barrel",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const baseStyles = new Styles("file:///tests/base-styles.ts", {
      panel: css`
        color: red;
      `,
    });

    const accentStyles = new Styles("file:///tests/accent-styles.ts", {
      badge: css`
        color: blue;
      `,
    });

    const barrelStyles = new Styles("file:///tests/barrel-styles.ts", {
      button: css`
        color: white;
      `,
    }, {
      imports: [baseStyles, accentStyles],
    });

    const handlers = new Handlers("file:///tests/barrel-handlers.ts", {
      clickHandler: function () {
        return "clicked";
      },
    });

    const { fn, styled } = await imports(barrelStyles, handlers);
    assertEquals(String(fn.clickHandler).includes("handlers."), true);
    assertEquals(styled.button.includes("button_"), true);
    assertEquals(styled.panel.includes("panel_"), true);
    assertEquals(styled.badge.includes("badge_"), true);
  },
});
