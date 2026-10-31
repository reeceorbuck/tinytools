#!/usr/bin/env -S deno run -A
/**
 * Builds the npm package (`@tinyenterprise/hono-tools`) from the JSR source
 * into `./npm`, ready for `npm publish`.
 *
 * JSR stays the source of truth: the files are those `deno.json` publishes,
 * the version and entry points are its `version` and `exports`, and
 * `package.json` only adds the npm name, dependencies and engines. The
 * TypeScript is compiled to plain JavaScript and declarations, because Node
 * will not strip types from files under `node_modules`, and loaders such as
 * tsx would compile the package's JSX with their own settings instead of
 * its `h` factory.
 *
 * The output targets `esnext` so handler functions keep their own source:
 * their `toString()` is what ships to the browser, and any downlevel helper
 * would reference module values that never ship.
 *
 * Usage: deno task build:npm
 */

import { expandGlob } from "@std/fs/expand-glob";
import { nodeCommand } from "./nodeCommand.ts";

const root = new URL("../", import.meta.url);
const outDir = new URL("npm/", root);
const srcDir = new URL("src/", outDir);

type AnyJson = Record<string, unknown>;

const readJson = async (url: URL): Promise<AnyJson> =>
  JSON.parse(await Deno.readTextFile(url));

const denoJson = await readJson(new URL("deno.json", root));
const manifest = await readJson(new URL("package.json", root));
const publish = denoJson.publish as { include: string[]; exclude?: string[] };
const imports = denoJson.imports as Record<string, string>;

/** `./build.ts` to `./dist/build.js`, or `.d.ts` for `types`. */
const distPath = (path: string, types = false) =>
  path.replace(/^\.\//, "./dist/").replace(
    /\.tsx?$/,
    types ? ".d.ts" : ".js",
  );

/** The npm version range of a mapped dependency (`jsr:@hono/hono@^4` → `^4`). */
const rangeOf = (name: string) => {
  const range = /@([^@/]+)$/.exec(imports[name] ?? "")?.[1];
  if (!range) throw new Error(`No version for "${name}" in deno.json imports`);
  return range;
};

await Deno.remove(outDir, { recursive: true }).catch(() => {});
await Deno.mkdir(srcDir, { recursive: true });

const sourceFiles: string[] = [];
const rootPath = decodeURIComponent(root.pathname).replace(/^\/(\w:)/, "$1");
for (const pattern of publish.include) {
  for await (
    const entry of expandGlob(pattern, {
      root: rootPath,
      exclude: publish.exclude,
      includeDirs: false,
    })
  ) {
    const relative = entry.path.slice(rootPath.length).replaceAll("\\", "/")
      .replace(/^\//, "");
    const isSource = /\.tsx?$/.test(relative);
    const target = new URL(isSource ? `src/${relative}` : relative, outDir);
    await Deno.mkdir(new URL("./", target), { recursive: true });
    if (!isSource) {
      await Deno.copyFile(new URL(relative, root), target);
      continue;
    }
    sourceFiles.push(relative);
    const source = await Deno.readTextFile(new URL(relative, root));
    await Deno.writeTextFile(target, toJsSpecifiers(source));
  }
}

/**
 * Points relative `.ts`/`.tsx` imports at the compiled `.js`. Done on the
 * source, not with tsc's `rewriteRelativeImportExtensions`, which wraps
 * every non-literal `import(url)` in a module-level helper, and handler
 * bodies that ship to the browser make such calls.
 */
function toJsSpecifiers(source: string): string {
  return source.replace(
    /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]+?)\.tsx?\2/g,
    "$1$2$3.js$2",
  );
}

const exportsMap = Object.fromEntries(
  Object.entries(denoJson.exports as Record<string, string>).map((
    [subpath, file],
  ) => [subpath, {
    types: distPath(file, true),
    default: distPath(file),
  }]),
);

const dependencies: Record<string, string> = {
  ...manifest.dependencies as Record<string, string>,
  hono: rangeOf("hono"),
  esbuild: rangeOf("esbuild"),
  "esbuild-wasm": rangeOf("esbuild-wasm"),
};

const npmManifest = {
  ...manifest,
  version: denoJson.version,
  exports: exportsMap,
  dependencies,
  files: ["dist", "README.md", "LICENSE"],
};
await Deno.writeTextFile(
  new URL("package.json", outDir),
  JSON.stringify(npmManifest, null, 2) + "\n",
);

const tsconfig = {
  compilerOptions: {
    target: "esnext",
    module: "nodenext",
    moduleResolution: "nodenext",
    verbatimModuleSyntax: false,
    jsx: "react",
    jsxFactory: "h",
    jsxFragmentFactory: "Fragment",
    lib: ["esnext", "dom", "dom.iterable", "dom.asynciterable"],
    types: ["node"],
    strict: true,
    skipLibCheck: true,
    declaration: true,
    removeComments: false,
    rootDir: "src",
    outDir: "dist",
  },
  files: sourceFiles.map((file) => `src/${file}`),
};
await Deno.writeTextFile(
  new URL("tsconfig.json", outDir),
  JSON.stringify(tsconfig, null, 2) + "\n",
);

async function run(cmd: string, args: string[]) {
  const { code } = await new Deno.Command(cmd, {
    args,
    cwd: outDir,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${code}`);
  }
}

const npm = nodeCommand("npm");
const npx = nodeCommand("npx");

// The manifest's own dependencies plus the compiler, without touching it.
await run(npm, [
  "install",
  "--no-save",
  "--no-package-lock",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "typescript@^7",
  "@types/node@^24",
]);
await run(npx, ["tsc", "-p", "tsconfig.json"]);

await Deno.remove(srcDir, { recursive: true });
await Deno.remove(new URL("tsconfig.json", outDir));
await Deno.remove(new URL("node_modules", outDir), { recursive: true });

console.log(`Built ${manifest.name}@${npmManifest.version} in ./npm`);
