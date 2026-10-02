import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  cache,
  Handlers,
  imports,
  registeredClientTools,
} from "../clientTools.ts";
import { buildScriptFiles } from "../build.ts";
import {
  handlerBundles,
  handlerFileDependencies,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";
import { AssetTags } from "../components/AssetTags.tsx";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

Deno.test({
  name: "AssetTags preloads every bundle a used handler imports transitively",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/asset-preload";
    const leaf = new Handlers(import.meta.url, {
      leafValue: function () {
        return "leaf";
      },
    });
    const middle = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(leaf);
      return {
        middleValue: function () {
          return fn.leafValue();
        },
      };
    });
    const top = new Handlers(import.meta.url, async () => {
      const { fn } = await imports(middle);
      return {
        topClick: function () {
          return fn.middleValue();
        },
      };
    });
    const unrelated = new Handlers(import.meta.url, {
      unrelatedValue: function () {
        return "unrelated";
      },
    });
    try {
      await buildScriptFiles({ fresh: true, publicDir: directory });
      const file = (
        tools: { _handlerFilenames: ReadonlyMap<string, string> },
        name: string,
      ) => `${tools._handlerFilenames.get(name)}.js`;
      const topFile = file(top, "topClick");
      const middleFile = file(middle, "middleValue");
      const leafFile = file(leaf, "leafValue");
      const unrelatedFile = file(unrelated, "unrelatedValue");

      // The built files really form the chain top -> middle -> leaf.
      const read = (name: string) =>
        Deno.readTextFileSync(`${directory}/handlers/${name}`);
      assertStringIncludes(read(topFile), `from "./${middleFile}"`);
      assertStringIncludes(read(middleFile), `from "./${leafFile}"`);

      assertEquals(handlerFileDependencies([topFile]), [middleFile, leafFile]);
      // Files already requested are not preloaded again.
      assertEquals(handlerFileDependencies([topFile, leafFile]), [middleFile]);
      assertEquals(handlerFileDependencies([unrelatedFile]), []);

      const html = String(
        await (<AssetTags accessedHandlerFiles={[topFile]} />).toString(),
      );
      assertEquals(
        html,
        `<script src="/handlers/${topFile}" type="module"></script>` +
          `<link rel="modulepreload" href="/handlers/${middleFile}"/>` +
          `<link rel="modulepreload" href="/handlers/${leafFile}"/>`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
    }
  },
});
