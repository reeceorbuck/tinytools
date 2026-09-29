import type { Plugin } from "esbuild";
import { getEsbuild } from "./esbuildInit.ts";

const reservedBindings = new Set(
  "arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield"
    .split(" "),
);

export function isBindingName(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name) && !reservedBindings.has(name);
}

/**
 * Blank out comments, string literals and template literal text (keeping
 * `${...}` expressions), so identifier scans only see code.
 */
function codeOnly(source: string): string {
  let out = "";
  // Stack of open template literals; each entry counts braces opened inside
  // its current `${...}` expression.
  const templates: number[] = [];
  let inTemplateText = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inTemplateText) {
      if (char === "\\") i++;
      else if (char === "`") {
        inTemplateText = false;
        templates.pop();
      } else if (char === "$" && source[i + 1] === "{") {
        inTemplateText = false;
        i++;
      }
      out += " ";
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      out += " ";
    } else if (char === '"' || char === "'") {
      for (i++; i < source.length && source[i] !== char; i++) {
        if (source[i] === "\\") i++;
      }
      out += " ";
    } else if (char === "`") {
      templates.push(0);
      inTemplateText = true;
      out += " ";
    } else if (templates.length && char === "{") {
      templates[templates.length - 1]++;
      out += char;
    } else if (templates.length && char === "}") {
      if (templates[templates.length - 1] === 0) inTemplateText = true;
      else templates[templates.length - 1]--;
      out += " ";
    } else {
      out += char;
    }
  }
  return out;
}

/** Matches method shorthand such as `name(`, `async name(` or `*name(`. */
function methodHeader(source: string): RegExpExecArray | null {
  if (/^(async\s+)?function\b/.test(source) || /^async\s*\(/.test(source)) {
    return null;
  }
  return /^(async\s+)?(\*\s*)?([$\w]+)\s*(?=\()/.exec(source);
}

/** Turn a `fn.toString()` result into an expression, including method shorthand. */
export function handlerExpression(source: string): string {
  const trimmed = source.trim();
  return methodHeader(trimmed)
    ? `Object.values({${trimmed}})[0]`
    : `(${trimmed})`;
}

/** Free identifiers used by code, ignoring strings, comments and properties. */
function identifiers(source: string): Set<string> {
  return new Set(codeOnly(source).match(/(?<![.$\w])[$A-Z_a-z][$\w]*/g));
}

/**
 * Declare an exported handler. Functions and methods become
 * `export function name(...)` (renamed to the handler name unless their own
 * name is used inside them); anything else, like arrows, becomes
 * `export const name = ...`.
 */
function exportedHandler(binding: string, source: string): string {
  const trimmed = source.trim();
  const fn = /^(async\s+)?function(\s*\*)?\s*([$A-Z_a-z][$\w]*)?\s*(?=\()/
    .exec(trimmed);
  const method = fn ? null : methodHeader(trimmed);
  const match = fn ?? method;
  const name = fn ? fn[3] ?? binding : method?.[3];
  if (
    match && name &&
    (name === binding ||
      !identifiers(trimmed.slice(match[0].length)).has(name))
  ) {
    return `export ${match[1] ? "async " : ""}function${
      match[2] ? "*" : ""
    } ${binding}${trimmed.slice(match[0].length)}`;
  }
  return `export const ${binding} = ${handlerExpression(trimmed)};`;
}

export type BundleSource = {
  /** Handlers in this bundle, exported under their names. */
  functions: ReadonlyMap<string, string>;
  /** Module-level code emitted before the handlers. */
  prelude?: string;
  /**
   * Handlers imported from other bundles. Keys are `name` (reachable as
   * `fn.name`, and as a bare identifier when valid) or `signal:name`
   * (reachable as `signal.name`).
   */
  dependencies: ReadonlyMap<string, { path: string; exportName: string }>;
  /** Binding name for module-private state, or false for stateless bundles. */
  stored: string | false;
  /** Additionally export this handler as the module default. */
  defaultExport?: string;
};

/**
 * Compile a bundle of handlers into one ES module. Returns the code and the
 * dependency keys that survive tree-shaking.
 */
export async function compileHandlerBundle(
  bundle: BundleSource,
  compiler?: Pick<typeof import("esbuild"), "build" | "transform">,
): Promise<{ code: string; dependencies: string[] }> {
  const { functions, prelude = "", dependencies, stored } = bundle;
  if (stored && !isBindingName(stored)) {
    throw new TypeError("Store state must use a simple parameter name.");
  }
  const hasSignals = [...dependencies.keys()].some((key) =>
    key.startsWith("signal:")
  );
  const reserved = new Set(["fn", "signal", ...(stored ? [stored] : [])]);
  const bareNames = [...dependencies.keys()].filter((key) =>
    isBindingName(key) && !reserved.has(key) && !functions.has(key)
  );

  // Handlers are module-level bindings so siblings can call each other.
  const occupied = new Set([...reserved, ...bareNames]);
  const handlerBindings = new Map<string, string>();
  let handlerIndex = 0;
  for (const name of functions.keys()) {
    let binding = name;
    if (!isBindingName(binding) || occupied.has(binding)) {
      do binding = `__tiny_handler_${++handlerIndex}`; while (
        occupied.has(binding)
      );
    }
    occupied.add(binding);
    handlerBindings.set(name, binding);
  }
  const exportName = (name: string) =>
    isBindingName(name) ? name : JSON.stringify(name);
  const renamed = [...handlerBindings].filter(([name, binding]) =>
    name !== binding
  );
  // Emitted as separate pieces so esbuild never renames locals that happen
  // to share a name with another module-level binding.
  const pieces = [
    prelude,
    ...[...functions].map(([name, source]) => {
      const binding = handlerBindings.get(name)!;
      return name === binding
        ? exportedHandler(binding, source)
        : `const ${binding} = ${handlerExpression(source)};`;
    }),
  ].filter(Boolean);
  // Generated export lines are emitted verbatim after the transformed pieces.
  const exportLines = [
    renamed.length
      ? `export { ${
        renamed.map(([name, binding]) => `${binding} as ${exportName(name)}`)
          .join(", ")
      } };`
      : "",
    bundle.defaultExport
      ? `export default ${handlerBindings.get(bundle.defaultExport)};`
      : "",
  ].filter(Boolean);
  const storedLine = stored ? `const ${stored} = Object.create(null);` : "";
  const body = [storedLine, ...pieces, ...exportLines].join("\n");

  // Pass 1: bundle against virtual `fn`/`signal` modules so esbuild's
  // tree-shaking tells us which dependencies are actually used. Each
  // dependency gets its own synthetic path, since several may share a bundle.
  const syntheticPaths = new Map(
    [...dependencies.keys()].map((key, index) => [key, `./__tiny_${index}.js`]),
  );
  const paths = new Set(syntheticPaths.values());
  const plugin: Plugin = {
    name: "tiny-handler-bundle",
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
          ).map(([key, { exportName: name }]) => {
            const exported = args.path === "signal" ? key.slice(7) : key;
            return `export { ${exportName(name)} as ${
              exportName(exported)
            } } from ${JSON.stringify(syntheticPaths.get(key))};`;
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
  const analysis = await esbuild.build({
    stdin: {
      contents: [
        'import * as fn from "tiny:fn";',
        hasSignals ? 'import * as signal from "tiny:signal";' : "",
        bareNames.length
          ? `import { ${bareNames.join(", ")} } from "tiny:fn";`
          : "",
        body,
      ].join("\n"),
      loader: "ts",
      sourcefile: "bundle.ts",
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
  const output = Object.values(analysis.metafile.outputs)[0] as {
    imports: { path: string }[];
  };
  const livePaths = new Set(output.imports.map((entry) => entry.path));
  const live = [...dependencies].filter(([key]) =>
    livePaths.has(syntheticPaths.get(key)!)
  );

  // Pass 2: emit with direct named imports in place of the virtual modules.
  // Imports keep their exported names unless that would clash with another
  // binding or shadow an identifier the handler code uses directly.
  const sourceIdentifiers = identifiers(
    [prelude, ...functions.values()].join("\n"),
  );
  const bindings = new Map<string, string>();
  for (const [key, { exportName: name }] of live) {
    let binding = key;
    if (!bareNames.includes(key)) {
      const unprefixed = key.replace(/^signal:/, "");
      const base = isBindingName(name)
        ? name
        : isBindingName(unprefixed)
        ? unprefixed
        : "dependency";
      binding = base;
      for (
        let index = 2;
        occupied.has(binding) || sourceIdentifiers.has(binding);
        index++
      ) {
        binding = `${base}${index}`;
      }
    }
    occupied.add(binding);
    bindings.set(key, binding);
  }
  const importsByPath = new Map<string, string[]>();
  for (const [key, { path, exportName: name }] of live) {
    const binding = bindings.get(key)!;
    const specifier = name === binding
      ? binding
      : `${exportName(name)} as ${binding}`;
    importsByPath.set(path, [...importsByPath.get(path) ?? [], specifier]);
  }
  const importLines = [...importsByPath].map(([path, specifiers]) =>
    `import { ${specifiers.join(", ")} } from ${JSON.stringify(path)};`
  );
  const namespace = (signals: boolean) =>
    live.filter(([key]) => key.startsWith("signal:") === signals).map((
      [key],
    ) => {
      const name = signals ? key.slice(7) : key;
      const binding = bindings.get(key)!;
      // Signal accessors are exposed as the signal itself, resolved lazily so
      // module evaluation order between bundles does not matter.
      if (signals) {
        const property = /^[$A-Z_a-z][$\w]*$/.test(name)
          ? name
          : `[${JSON.stringify(name)}]`;
        return `get ${property}() { return ${binding}(); }`;
      }
      return name === binding && name !== "__proto__"
        ? binding
        : `[${JSON.stringify(name)}]: ${binding}`;
    }).join(", ");
  const fnMembers = namespace(false);
  const signalMembers = namespace(true);
  const transformed = await Promise.all(
    pieces.map(async (piece) =>
      (await esbuild.transform(piece, { loader: "ts", target: "esnext" })).code
        .trim()
    ),
  );
  const code = [
    ...importLines,
    fnMembers && sourceIdentifiers.has("fn")
      ? `const fn = { ${fnMembers} };`
      : "",
    signalMembers && sourceIdentifiers.has("signal")
      ? `const signal = { ${signalMembers} };`
      : "",
    stored && sourceIdentifiers.has(stored) ? storedLine : "",
    ...transformed,
    ...exportLines,
  ].filter(Boolean).join("\n") + "\n";
  return {
    code,
    dependencies: live.map(([key]) => key),
  };
}
