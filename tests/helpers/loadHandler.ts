import { assertExists } from "@std/assert";
import { handlerBundles, handlers } from "../../clientFunctions.ts";
import { signalRuntimeSources } from "../../signalModules.ts";

const bundleUrls = new Map<string, Promise<string>>();

/** Replace imports of runtime modules (`./tt-*.js`) with `data:` URLs. */
function inlineRuntimeImports(code: string): string {
  for (const [file, source] of signalRuntimeSources) {
    const specifier = JSON.stringify(`./${file}`);
    if (!code.includes(specifier)) continue;
    code = code.replaceAll(
      specifier,
      JSON.stringify(
        `data:text/javascript,${
          encodeURIComponent(inlineRuntimeImports(source))
        }`,
      ),
    );
  }
  return code;
}

/** Build a bundle as a `data:` module URL, inlining its bundle imports. */
export function bundleUrl(filename: string): Promise<string> {
  let url = bundleUrls.get(filename);
  if (!url) {
    url = (async () => {
      const bundle = [...handlerBundles].find((candidate) =>
        candidate.filename === filename
      );
      assertExists(bundle, `No bundle named ${filename}`);
      let code = await bundle.buildCode();
      for (const [, impl] of bundle.dependencies) {
        const specifier = JSON.stringify(`./${impl.filename}.js`);
        code = code.replaceAll(
          specifier,
          JSON.stringify(await bundleUrl(impl.filename)),
        );
      }
      return `data:text/javascript,${
        encodeURIComponent(inlineRuntimeImports(code))
      }`;
    })();
    bundleUrls.set(filename, url);
  }
  return url;
}

/** Load a built handler by name (the first registered handler with that name). */
// deno-lint-ignore no-explicit-any
export async function loadHandler<T = (...args: any[]) => any>(
  name: string,
  filename?: string,
): Promise<T> {
  const impl = [...handlers.values()].find((candidate) =>
    candidate.fnName === name &&
    (filename === undefined || candidate.filename === filename)
  );
  assertExists(impl, `No handler named ${name}`);
  return (await import(await bundleUrl(impl.filename)))[name];
}
