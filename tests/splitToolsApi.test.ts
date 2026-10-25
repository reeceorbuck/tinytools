import { assertEquals } from "@std/assert";
import { Handlers, imports, Styles } from "../clientTools.ts";
import { handlerReferenceAttributes } from "../eventAttributes.ts";
import { css } from "../scopedStyles.ts";

/** The `<bundle>.<name>` a handler reference renders as. */
const handlerOf = (reference: unknown) =>
  handlerReferenceAttributes("onClick", reference)?.["tt-handler-click"] ?? "";

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

    const componentStyles = new Styles(
      "file:///tests/split-component-styles.ts",
      {
        component: css`
          display: block;
        `,
      },
    );

    const { fn, styled } = await imports(styles, componentStyles);
    assertEquals(styled.panel.includes("panel_"), true);
    assertEquals(styled.component.includes("component_"), true);
    // @ts-expect-error Style-only imports must not expose arbitrary handlers.
    fn.missingHandler;
    // @ts-expect-error Imported styles must not expose arbitrary style names.
    styled.missingStyle;
  },
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

    const localHandlers = new Handlers(
      "file:///tests/local-handlers.ts",
      async () => {
        const { fn } = await imports(sharedHandlers);
        return {
          localHandler: function () {
            return `local ${fn.sharedHandler()}`;
          },
        };
      },
    );

    const { fn } = await imports(localHandlers);
    assertEquals(
      /^local_handlers_\w+\.localHandler$/.test(handlerOf(fn.localHandler)),
      true,
    );
    const bundle = localHandlers._handlerDefinitions.get("localHandler")!
      .bundle;
    assertEquals([...bundle.dependencies.keys()], ["sharedHandler"]);
    assertEquals(
      bundle.reachableFilenames.includes(
        sharedHandlers._handlerFilenames.get("sharedHandler")!,
      ),
      true,
    );
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
    assertEquals(handlerOf(fn.clickHandler).endsWith(".clickHandler"), true);
    assertEquals(styled.button.includes("button_"), true);
  },
});

Deno.test({
  name: "split tools api - separate style tools engage together",
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

    const buttonStyles = new Styles("file:///tests/button-styles.ts", {
      button: css`
        color: white;
      `,
    });

    const handlers = new Handlers("file:///tests/barrel-handlers.ts", {
      clickHandler: function () {
        return "clicked";
      },
    });

    const { fn, styled } = await imports(
      baseStyles,
      accentStyles,
      buttonStyles,
      handlers,
    );
    assertEquals(handlerOf(fn.clickHandler).endsWith(".clickHandler"), true);
    assertEquals(styled.button.includes("button_"), true);
    assertEquals(styled.panel.includes("panel_"), true);
    assertEquals(styled.badge.includes("badge_"), true);
  },
});
