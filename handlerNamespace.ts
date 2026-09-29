import type { Plugin } from "esbuild";
import { getEsbuild } from "./esbuildInit.ts";

const reservedBindings = new Set(
  "arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield"
    .split(" "),
);

function isBindingName(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name) && !reservedBindings.has(name);
}

export function handlerDefaultExport(
  source: string,
  name: string,
  occupiedBindings: ReadonlySet<string> = new Set(),
): string {
  const trimmed = source.trim();
  const header = /^(async\s+)?function(\s*\*)?\s*([$A-Z_a-z][$\w]*)?\s*(?=\()/
    .exec(trimmed);
  if (header) {
    const functionName = header[3] ?? name;
    const shadowsReference = !header[3] &&
      new Set(trimmed.match(/[$A-Z_a-z][$\w]*/g) ?? []).has(functionName);
    if (
      isBindingName(functionName) && !occupiedBindings.has(functionName) &&
      !shadowsReference
    ) {
      return `export default ${header[1] ?? ""}function${
        header[2] ? "*" : ""
      } ${functionName}${trimmed.slice(header[0].length)};`;
    }
  }
  const isMethod = !/^(async\s+)?function\b/.test(trimmed) &&
    !/^async\s*\(/.test(trimmed) &&
    /^(async\s+)?\*?\s*[$\w]+\s*\(/.test(trimmed);
  return isMethod
    ? `export default Object.values({${trimmed}})[0];`
    : `export default (${trimmed});`;
}

export async function compileHandlerNamespace(
  source: string,
  name: string,
  _filename: string,
  dependencies: ReadonlyMap<string, string>,
  compiler?: Pick<typeof import("esbuild"), "build">,
  stateful: boolean | string = false,
): Promise<{ code: string; imports: string[] }> {
  const storedBinding = typeof stateful === "string" ? stateful : "stored";
  if (stateful && !isBindingName(storedBinding)) {
    throw new TypeError("Store state must use a simple parameter name.");
  }
  const hasSignals = [...dependencies.keys()].some((key) =>
    key.startsWith("signal:")
  );
  const bareNames = [...dependencies.keys()].filter((key) =>
    isBindingName(key) && key !== "fn" && key !== "_handler" &&
    (!hasSignals || key !== "signal") &&
    (!stateful || key !== storedBinding)
  );
  const bareImports = bareNames.length
    ? `import { ${bareNames.join(", ")} } from "tiny:fn";`
    : "";
  const paths = new Set(dependencies.values());
  const plugin: Plugin = {
    name: "tiny-handler-namespace",
    setup(build) {
      build.onResolve({ filter: /^tiny:(fn|signal)$/ }, (args) => ({
        path: args.path.slice(5),
        namespace: "tiny-handlers",
      }));
      build.onLoad(
        { filter: /^(fn|signal)$/, namespace: "tiny-handlers" },
        (args) => ({
          contents: [...dependencies].filter(([key]) =>
            key.startsWith("signal:") === (args.path === "signal")
          ).map(([key, path]) => {
            const exportName = args.path === "signal" ? key.slice(7) : key;
            return (
              isBindingName(exportName)
                ? `import ${exportName} from ${
                  JSON.stringify(path)
                };\nexport { ${exportName} };`
                : `export { default as ${JSON.stringify(exportName)} } from ${
                  JSON.stringify(path)
                };`
            );
          }).join("\n"),
          loader: "js",
        }),
      );
      build.onResolve({ filter: /.*/, namespace: "tiny-handlers" }, (args) => {
        if (!paths.has(args.path)) {
          throw new Error(`Unknown handler: ${args.path}`);
        }
        return { path: args.path, external: true, sideEffects: false };
      });
    },
  };
  const esbuild = compiler ?? await getEsbuild();
  const handlerSource = `${
    stateful ? `const ${storedBinding} = Object.create(null);\n` : ""
  }${
    handlerDefaultExport(
      source,
      name,
      new Set([
        "fn",
        ...(hasSignals ? ["signal"] : []),
        storedBinding,
        ...dependencies.keys(),
      ]),
    )
  }`;
  const result = await esbuild.build({
    stdin: {
      contents: `import * as fn from "tiny:fn";\n${
        hasSignals ? 'import * as signal from "tiny:signal";' : ""
      }\n${bareImports}\n${handlerSource}`,
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
  const livePaths = new Set(output.imports.map((entry) => entry.path));
  const bindings = new Map<string, string>();
  const importLines: string[] = [];
  for (const [exportName, path] of dependencies) {
    if (!livePaths.has(path)) continue;
    let binding = exportName;
    if (!bareNames.includes(binding)) {
      const isSignal = exportName.startsWith("signal:");
      const preferred = isSignal ? exportName.slice(7) : exportName;
      const isOccupied = (candidate: string) =>
        candidate === "fn" || candidate === "signal" || candidate === name ||
        candidate === storedBinding || dependencies.has(candidate) ||
        [...bindings.values()].includes(candidate);
      const escaped = preferred.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        isBindingName(preferred) && !isOccupied(preferred) &&
        !new RegExp(`(^|[^.$\\w])${escaped}(?![$\\w])`).test(source)
      ) {
        binding = preferred;
      } else {
        const prefix = isSignal ? "signal" : "dependency";
        let index = 1;
        binding = `${prefix}${index}`;
        while (isOccupied(binding) || source.includes(binding)) {
          binding = `${prefix}${++index}`;
        }
      }
    }
    bindings.set(exportName, binding);
    importLines.push(`import ${binding} from ${JSON.stringify(path)};`);
  }
  const members = [...bindings].filter(([name]) => !name.startsWith("signal:"))
    .map(([exportName, binding]) =>
      exportName === binding && exportName !== "__proto__"
        ? binding
        : `[${JSON.stringify(exportName)}]: ${binding}`
    );
  const signalMembers = [...bindings].filter(([name]) =>
    name.startsWith("signal:")
  ).map(([name, binding]) => `[${JSON.stringify(name.slice(7))}]: ${binding}`);
  const emitted = await esbuild.build({
    stdin: {
      contents: `${importLines.join("\n")}\nconst fn = {${
        members.join(", ")
      }};\n${
        hasSignals ? `const signal = {${signalMembers.join(", ")}};` : ""
      }\n${handlerSource}`,
      loader: "ts",
      sourcefile: `${name}.ts`,
    },
    bundle: false,
    treeShaking: true,
    write: false,
    target: "esnext",
    logLevel: "silent",
  });
  return {
    code: emitted.outputFiles[0].text,
    imports: output.imports.map((entry) => entry.path),
  };
}
