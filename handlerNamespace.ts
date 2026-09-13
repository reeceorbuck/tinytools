import type { Plugin } from "esbuild";
import { getEsbuild } from "./esbuildInit.ts";

const reservedBindings = new Set(
  "arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield"
    .split(" "),
);

function isBindingName(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name) && !reservedBindings.has(name);
}

export async function compileHandlerNamespace(
  source: string,
  name: string,
  filename: string,
  dependencies: ReadonlyMap<string, string>,
  compiler?: Pick<typeof import("esbuild"), "build">,
): Promise<{ code: string; imports: string[] }> {
  const trimmed = source.trim();
  const isMethod = !/^(async\s+)?function\b/.test(trimmed) &&
    !/^async\s*\(/.test(trimmed) &&
    /^(async\s+)?\*?\s*[$\w]+\s*\(/.test(trimmed);
  const expression = isMethod
    ? `Object.values({${trimmed}})[0]`
    : `(${trimmed})`;
  const bareNames = [...dependencies.keys()].filter((key) =>
    isBindingName(key) && key !== "fn" && key !== "_handler"
  );
  const bareImports = bareNames.length
    ? `import { ${bareNames.join(", ")} } from "tiny:fn";`
    : "";
  const paths = new Set(dependencies.values());
  const plugin: Plugin = {
    name: "tiny-handler-namespace",
    setup(build) {
      build.onResolve({ filter: /^tiny:fn$/ }, () => ({
        path: "fn",
        namespace: "tiny-handlers",
      }));
      build.onLoad({ filter: /^fn$/, namespace: "tiny-handlers" }, () => ({
        contents: [...dependencies].map(([exportName, path]) =>
          isBindingName(exportName)
            ? `import ${exportName} from ${
              JSON.stringify(path)
            };\nexport { ${exportName} };`
            : `export { default as ${JSON.stringify(exportName)} } from ${
              JSON.stringify(path)
            };`
        ).join("\n"),
        loader: "js",
      }));
      build.onResolve({ filter: /.*/, namespace: "tiny-handlers" }, (args) => {
        if (!paths.has(args.path)) {
          throw new Error(`Unknown handler: ${args.path}`);
        }
        return { path: args.path, external: true, sideEffects: false };
      });
    },
  };
  const esbuild = compiler ?? await getEsbuild();
  const result = await esbuild.build({
    stdin: {
      contents:
        `import * as fn from "tiny:fn";\n${bareImports}\nconst _handler = ${expression};\nexport default _handler;\nglobalThis.handlers ??= {};\nglobalThis.handlers[${
          JSON.stringify(filename)
        }] = _handler;`,
      loader: "ts",
      sourcefile: `${name}.ts`,
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    target: "esnext",
    logLevel: "silent",
    logOverride: { "import-is-undefined": "error" },
    plugins: [plugin],
  });
  const output = Object.values(result.metafile.outputs)[0] as {
    imports: { path: string }[];
  };
  return {
    code: result.outputFiles[0].text,
    imports: output.imports.map((entry) => entry.path),
  };
}
