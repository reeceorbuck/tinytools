import { assertEquals, assertStringIncludes } from "@std/assert";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Constants,
  Handlers,
  imports,
  registeredClientTools,
  SignalComponent,
  Signals,
  Styles,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import { jsx } from "../jsx-runtime.ts";
import { css } from "../scopedStyles.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import { resetImportUsage, unusedImports } from "../importUsage.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
  resetImportUsage();
}

/** The unused labels at sites in this file. */
const unusedHere = () =>
  unusedImports().filter(({ site }) => site.startsWith(import.meta.url));

Deno.test({
  name: "unused tiny.imports() arguments are reported by call site",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/import-usage";
    const used = new Handlers(import.meta.url, { press() {} });
    const leftOver = new Handlers(import.meta.url, { forgotten() {} });
    const styles = new Styles(import.meta.url, {
      box: css`display: block;`,
      unread: css`display: none;`,
    });
    const unreadStyles = new Styles(import.meta.url, {
      gone: css`color: red;`,
    });
    const counts = new Signals(import.meta.url, ({ Signal }) => ({
      count: new Signal(0),
    }));
    const defaults = new Constants({ size: 3 });
    const unreadDefaults = new Constants({ colour: "red" });
    const Parts = new SignalComponent(() => ({
      Box: () => jsx("div", {}),
      Button: () => jsx("button", {}),
    }));
    const Unread = new SignalComponent(() => ({ Panel: () => jsx("p", {}) }));
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      // One call site, rendered twice: a read on either render counts.
      const page = async (branch: boolean) => {
        const { fn, styled, signal, constants, component } = await imports(
          used,
          leftOver,
          styles,
          unreadStyles,
          counts,
          defaults,
          unreadDefaults,
          Parts,
          Unread,
        );
        const parts = component.instance();
        return [
          branch ? fn.press : styled.box,
          signal.count,
          constants.size,
          parts.Box,
        ];
      };
      await page(false);
      assertEquals(unusedHere().length, 1);
      const [{ site, unused, definition }] = unusedHere();
      assertEquals(definition, false);
      assertEquals(/importUsage\.test\.ts:\d+:\d+$/.test(site), true);
      assertEquals(unused, [
        "Handlers in importUsage.test.ts (press)",
        "Handlers in importUsage.test.ts (forgotten)",
        "Styles in importUsage.test.ts (gone)",
        "Constants (colour)",
        "SignalComponent (Panel)",
      ]);
      // The other branch reads `used`; nothing reads the rest.
      await page(true);
      assertEquals(unusedHere()[0].unused, [
        "Handlers in importUsage.test.ts (forgotten)",
        "Styles in importUsage.test.ts (gone)",
        "Constants (colour)",
        "SignalComponent (Panel)",
      ]);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "a definition's unused imports are warned about from its source",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/import-usage-definition";
    const helpers = new Handlers(import.meta.url, { double: (n: number) => n });
    const leftOver = new Handlers(import.meta.url, { forgotten() {} });
    const defaults = new Constants({ start: 1 });
    const definition = new Handlers(import.meta.url, async () => {
      const { fn, constants } = await imports(helpers, leftOver, defaults);
      return {
        compute() {
          return fn.double(constants.start);
        },
      };
    });
    // Constants passed along whole may be read anywhere, so count as used.
    const passedWhole = new Constants({ first: 1, second: 2 });
    const signals = new Signals(import.meta.url, async () => {
      const { fn, constants } = await imports(helpers, leftOver, passedWhole);
      return ({ Computed }) => ({
        doubled: new Computed(() => fn.double(Object.keys(constants).length)),
      });
    });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      const text = args.join(" ");
      if (text.includes(import.meta.url)) warnings.push(text);
    };
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      await imports(definition, signals);
      assertEquals(warnings.length, 2, warnings.join("\n---\n"));
      for (const warning of warnings) {
        assertStringIncludes(warning, "imports what its handlers never use");
        assertStringIncludes(
          warning,
          "- Handlers in importUsage.test.ts (forgotten)",
        );
        assertEquals(warning.includes("double"), false);
        assertEquals(warning.includes("Constants"), false);
      }
      const reported = unusedHere().filter((found) => found.definition);
      assertEquals(reported.length, 2);
      // Prod mode records nothing.
      reset();
      (cache as { trustCache: boolean }).trustCache = true;
      await imports(new Handlers(import.meta.url, { quiet() {} }));
      assertEquals(unusedHere(), []);
    } finally {
      console.warn = warn;
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});
