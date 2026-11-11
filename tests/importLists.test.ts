import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Handlers,
  imports,
  registeredClientTools,
  withNoContextToolUsageTracker,
} from "../clientTools.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import { handlerReferenceAttributes } from "../eventAttributes.ts";
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

/** The `<bundle>.<name>` a handler reference renders as. */
const handlerOf = (reference: unknown) =>
  handlerReferenceAttributes("onClick", reference)?.["tt-handler-click"] ?? "";

/** The unused labels at sites in this file. */
const unusedHere = () =>
  unusedImports().filter(({ site }) => site.startsWith(import.meta.url));

Deno.test({
  name: "a list is imported as one, recording only the bundles read",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const a = new Handlers(import.meta.url, { one() {} });
    const b = new Handlers(import.meta.url, { two() {} });
    const c = new Handlers(import.meta.url, { three() {} });
    // A list may hold lists of its own.
    const kit = [a, [b, c]] as const;
    try {
      const tracker = {
        accessedHandlerFiles: new Set<string>(),
        accessedStyleFiles: new Set<string>(),
        accessedLifecycleTags: new Set<string>(),
      };
      await withNoContextToolUsageTracker(tracker, async () => {
        const { fn } = await imports(kit);
        assertEquals(
          handlerOf(fn.three),
          `${c._handlerFilenames.get("three")}.three`,
        );
      });
      assertEquals([...tracker.accessedHandlerFiles], [
        `${c._handlerFilenames.get("three")}.js`,
      ]);
      // Every member's handlers are on `fn`, typed.
      const { fn } = await imports(kit);
      assertEquals([fn.one, fn.two].map(handlerOf), [
        `${a._handlerFilenames.get("one")}.one`,
        `${b._handlerFilenames.get("two")}.two`,
      ]);
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "a list is one namespace: two members defining a name throw",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const first = new Handlers(import.meta.url, { same() {} });
    const second = new Handlers(import.meta.url, { same() {} });
    try {
      await assertRejects(
        () => imports([first, second]),
        TypeError,
        "fn.same is defined by two collections of one tiny.imports() list",
      );
      // As separate arguments, the last one wins.
      const { fn } = await imports(first, second);
      assertEquals(
        handlerOf(fn.same),
        `${second._handlerFilenames.get("same")}.same`,
      );
      // The same collection twice in a list is no clash.
      await imports([first, [first]]);
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "the unused-import report counts a list as used once a member is",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const used = new Handlers(import.meta.url, { press() {} });
    const spare = new Handlers(import.meta.url, { spare() {} });
    const unread = new Handlers(import.meta.url, { never() {} });
    try {
      // Written inline, each render makes new lists: they are still the
      // same imports.
      const page = async () => {
        const { fn } = await imports([used, spare], [unread]);
        return fn.press;
      };
      await page();
      await page();
      assertEquals(unusedHere().map(({ unused }) => unused), [
        ["List of 1 collection (never)"],
      ]);
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "a definition's list ships only what it uses and warns as one import",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const helpers = new Handlers(import.meta.url, {
      double: (n: number) => n * 2,
    });
    const spare = new Handlers(import.meta.url, { spare() {} });
    const kit = [helpers, spare] as const;
    const definition = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(kit);
      return {
        compute() {
          return fn.double(2);
        },
      };
    });
    // In a tools list, a list is one import too.
    const listed = new Handlers(import.meta.url, [kit], ({ fn }) => ({
      triple() {
        return fn.double(3);
      },
    }));
    const idle = new Handlers(import.meta.url, async () => {
      await imports(kit);
      return { nothing() {} };
    });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      const text = args.join(" ");
      if (text.includes(import.meta.url)) warnings.push(text);
    };
    try {
      await imports(definition, listed, idle);
      // Only the list nothing reads is warned about, once.
      assertEquals(warnings.length, 1, warnings.join("\n---\n"));
      assertStringIncludes(
        warnings[0],
        "- List of 2 collections (double, spare)",
      );
      for (const tools of [definition, listed]) {
        const bundle = [...tools._handlerDefinitions.values()][0].bundle;
        await bundle.pruneDependencies();
        assertEquals([...bundle.dependencies.keys()], ["double"]);
      }
    } finally {
      console.warn = warn;
      reset();
      (await getEsbuild()).stop();
    }
  },
});
