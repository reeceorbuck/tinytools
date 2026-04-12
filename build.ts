performance.mark("import:@tinytools/hono-tools/build:start");
/**
 * Build module for @tinytools/hono-tools
 *
 * Provides build functionality for client functions and scoped styles.
 * This module uses esbuild to transpile TypeScript handlers to JavaScript.
 *
 * @module
 */

import * as esbuild from "esbuild";
performance.mark("import:esbuild:done");
import { cache, registeredClientTools } from "./clientTools.ts";
import { changedHandlerKeys, handlers } from "./clientFunctions.ts";
performance.mark("import:clientFunctions:done");
import {
  changedStyleKeys,
  type ScopedStyleEntry,
  type ScopedStyleLayer,
  scopedStylesRegistry,
  styleBundleRegistry,
} from "./scopedStyles.ts";
performance.mark("import:scopedStyles:done");

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

const STYLE_LAYER_ORDER: ScopedStyleLayer[] = [
  "global",
  "unscoped",
  "limited",
  "normal",
  "important",
  "debug",
];

export function buildLayeredCssContent(styles: ScopedStyleEntry[]): string {
  const byLayer = new Map<ScopedStyleLayer, string[]>();

  for (const style of styles) {
    const current = byLayer.get(style.layer) ?? [];
    current.push(style.buildCssLayerContent());
    byLayer.set(style.layer, current);
  }

  return STYLE_LAYER_ORDER
    .flatMap((layer) => {
      const layerContent = byLayer.get(layer);
      if (!layerContent || layerContent.length === 0) {
        return [];
      }

      return [`@layer ${layer} {${layerContent.join("\n")}}`];
    })
    .join("\n");
}

/**
 * Build code for a handler function into a standalone ES module.
 * This transforms TypeScript to JavaScript that can be served to the browser.
 *
 * @param fnName The name of the function
 * @param fn The function to build
 * @param filename The output filename (without extension)
 * @param importRegistry Map of function names to their filenames for import generation
 * @returns The transpiled JavaScript code as a string
 */
export async function buildHandlerCode(
  fnName: string,
  fn: AnyFunction,
  filename: string,
  importRegistry: Map<string, string>,
): Promise<string> {
  console.log("Building code for handler: ", fnName);

  const importLines: string[] = [];

  for (const [name, importFilename] of importRegistry.entries()) {
    // Avoid self-imports; they are unnecessary and can create circular deps.
    if (name === fnName || importFilename === filename) continue;
    importLines.push(
      `import { default as ${name} } from "./${importFilename}.js";`,
    );
  }

  // Convert function to string and normalize it to a stable expression bound to a
  // known symbol. This supports named and anonymous functions.
  const fnString = fn.toString();
  const handlerExportName = "_handler";

  const trimmedFnString = fnString.trim();
  const looksLikeFunctionKeyword = /^(async\s+)?function\b/.test(
    trimmedFnString,
  );
  const functionExpression = looksLikeFunctionKeyword
    ? `(${trimmedFnString})`
    : trimmedFnString;

  const functionCode = `${
    importLines.join("\n")
  }\nconst ${handlerExportName} = ${functionExpression};\nexport { ${handlerExportName} as default };\nglobalThis.handlers ??= {};\nglobalThis.handlers["${filename}"] = ${handlerExportName};`;
  console.log("Function code: ", functionCode);

  const result = await esbuild.transform(functionCode, {
    loader: "ts",
    format: "esm",
    target: ["esnext"],
    sourcemap: false,
  }).catch((err) => {
    console.error("Esbuild transform error: ", err);
    return { code: functionCode };
  });

  return result.code;
}

/** Options for the build process */
export interface BuildOptions {
  /** Directory containing client-side TypeScript files to transpile (user scripts) */
  clientDir?: string;
  /** Output directory for built files */
  publicDir?: string;
  /** Subdirectory for handler files (relative to publicDir) */
  handlerDir?: string;
  /** Subdirectory for style files (relative to publicDir) */
  stylesDir?: string;
  /**
   * Skip all cache and file-existence checks. Build everything unconditionally.
   * Ideal for hosted/isolated environments (e.g. V8 isolates) where no prior
   * build artifacts or cache exist.
   */
  fresh?: boolean;
  /**
   * Transpile user-provided client-side TypeScript files from `clientDir` into
   * `publicDir`. Defaults to `false`.
   */
  transpileClientFiles?: boolean;
}

/**
 * Build all registered handlers to JavaScript files.
 *
 * @param handlerDir Output directory for handler .js files
 * @param options.fresh If true, skip file-existence and dependency checks — build everything unconditionally
 * @returns Array of handler filenames (without extension) that were built or already existed
 */
export async function buildHandlers(
  handlerDir: string,
  options: { fresh?: boolean } = {},
): Promise<string[]> {
  const { fresh = false } = options;

  return await Promise.all(
    [...handlers.values()].map(async (handler) => {
      const { filename } = handler;

      if (!fresh) {
        const fileExists = await Deno.stat(`${handlerDir}/${filename}.js`)
          .then(() => true)
          .catch(() => false);

        const needsRebuildForDeps = handler.needsRebuildDueToDependencyChange();

        if (fileExists && !needsRebuildForDeps) {
          return filename;
        }

        if (needsRebuildForDeps) {
          console.log(
            `Rebuilding handler ${filename} because a dependency changed.`,
          );
        }
      }

      console.log(`Building file for handler:`, handler.buildCode);
      const functionCode = await handler.buildCode();
      await Deno.writeTextFile(`${handlerDir}/${filename}.js`, functionCode);
      console.log(`Handler file written: ${handlerDir}/${filename}.js`);
      return filename;
    }),
  );
}

/**
 * Build all registered style bundles and individual global styles to CSS files.
 *
 * @param stylesDir Output directory for style .css files
 * @param options.fresh If true, skip file-existence checks — build everything unconditionally
 * @returns Array of style filenames (without extension) that were built or already existed
 */
export async function buildStyles(
  stylesDir: string,
  options: { fresh?: boolean } = {},
): Promise<string[]> {
  const { fresh = false } = options;

  const styleFiles = await Promise.all(
    [...styleBundleRegistry.entries()].map(
      async ([bundleFilename, styles]) => {
        const filePath = `${stylesDir}/${bundleFilename}.css`;

        if (!fresh) {
          const fileExists = await Deno.stat(filePath)
            .then(() => true)
            .catch(() => false);

          const anyStyleChanged = styles.some((style) => {
            const styleKey = style.sourceFileUrl
              ? `${style.sourceFileUrl}::${style.styleName}`
              : "";
            return styleKey && changedStyleKeys.has(styleKey);
          });

          if (fileExists && !anyStyleChanged) {
            return bundleFilename;
          }

          if (anyStyleChanged) {
            console.log(
              `Rebuilding style bundle ${bundleFilename} because a constituent style changed.`,
            );
          }
        }

        const cssContent = buildLayeredCssContent(styles);
        await Deno.writeTextFile(filePath, cssContent);
        console.log(
          `Style bundle written: ${filePath} (${styles.length} styles)`,
        );
        return bundleFilename;
      },
    ),
  );

  const globalStyleFiles = await Promise.all(
    [...scopedStylesRegistry.values()]
      .filter((style) => {
        for (const bundleStyles of styleBundleRegistry.values()) {
          if (bundleStyles.some((bs) => bs.filename === style.filename)) {
            return false;
          }
        }
        return true;
      })
      .map(async (style) => {
        const { filename, sourceFileUrl, styleName } = style;
        const filePath = `${stylesDir}/${filename}.css`;

        if (!fresh) {
          const fileExists = await Deno.stat(filePath)
            .then(() => true)
            .catch(() => false);

          const styleKey = sourceFileUrl
            ? `${sourceFileUrl}::${styleName}`
            : "";
          const styleChanged = styleKey && changedStyleKeys.has(styleKey);

          if (fileExists && !styleChanged) {
            return filename;
          }
        }

        const cssContent = buildLayeredCssContent([style]);
        await Deno.writeTextFile(filePath, cssContent);
        console.log(`Global style file written: ${filePath}`);
        return filename;
      }),
  );

  return [...styleFiles, ...globalStyleFiles];
}

/**
 * Scan a directory for .ts/.tsx files and transpile them to .js.
 *
 * @param clientDir Source directory containing TypeScript files
 * @param publicDir Output directory for transpiled .js files
 * @returns Array of built base filenames (without extension)
 */
export async function transpileClientDir(
  clientDir: string,
  publicDir: string,
): Promise<string[]> {
  let files: Deno.DirEntry[];
  try {
    files = (await Array.fromAsync(Deno.readDir(clientDir)))
      .filter((entry) => entry.isFile)
      .filter((entry) =>
        entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      );
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  console.log(
    "User client files to process:",
    files.map((s) => s.name),
  );

  return Promise.all(
    files.map((entry) => transpileClientFile(entry.name, clientDir, publicDir)),
  );
}

/**
 * Remove handler and style files that are no longer registered.
 *
 * @param handlerDir Directory containing handler .js files
 * @param stylesDir Directory containing style .css files
 * @param validHandlerFiles Current valid handler filenames (without extension)
 * @param validStyleFiles Current valid style filenames (without extension)
 */
export async function cleanupStaleFiles(
  handlerDir: string,
  stylesDir: string,
  validHandlerFiles: string[],
  validStyleFiles: string[],
): Promise<void> {
  for await (const dirEntry of Deno.readDir(handlerDir)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".js")) {
      const fileName = dirEntry.name.replace(/\.js$/, "");
      if (!validHandlerFiles.includes(fileName)) {
        console.log("Removing handler file: ", dirEntry.name);
        await Deno.remove(`${handlerDir}/${dirEntry.name}`);
      }
    }
  }

  for await (const dirEntry of Deno.readDir(stylesDir)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".css")) {
      const fileName = dirEntry.name.replace(/\.css$/, "");
      if (!validStyleFiles.includes(fileName)) {
        console.log("Removing style file: ", dirEntry.name);
        await Deno.remove(`${stylesDir}/${dirEntry.name}`);
      }
    }
  }
}

/**
 * Builds all registered client functions and scoped styles to the public directory.
 * Stops the esbuild worker when done so the process can exit cleanly.
 *
 * @param options Build configuration options
 *
 * @example
 * ```ts
 * import { buildScriptFiles } from "@tinytools/hono-tools/build";
 *
 * // Build with default options (incremental, cache-aware)
 * await buildScriptFiles();
 *
 * // Fresh build for hosted environments (skip all cache/existence checks)
 * await buildScriptFiles({ fresh: true });
 *
 * // Include user client-side TypeScript transpilation
 * await buildScriptFiles({ transpileClientFiles: true });
 * ```
 */
export async function buildScriptFiles(options: BuildOptions = {}) {
  const {
    clientDir = "./client",
    publicDir = "./public",
    handlerDir = `${publicDir}/handlers`,
    stylesDir = `${publicDir}/styles`,
    fresh = false,
    transpileClientFiles: shouldTranspileClient = false,
  } = options;

  performance.mark("startup:buildScriptFilesStart");
  performance.mark("buildScriptFiles:begin");

  // --- Revalidation phase (skip in fresh mode — filenames are already determined) ---
  performance.mark("buildScriptFiles:revalidateStart");
  if (!fresh) {
    cache.beginChangeDetectionPass();

    for (const handler of handlers.values()) {
      await handler.revalidateAndBuild(handlerDir);
    }
    for (const style of scopedStylesRegistry.values()) {
      style.revalidate();
    }

    for (const tools of registeredClientTools) {
      const { oldBundleFilename, newBundleFilename } = tools
        .refreshStyleAssetMappings();
      if (
        oldBundleFilename && newBundleFilename &&
        oldBundleFilename !== newBundleFilename
      ) {
        styleBundleRegistry.delete(oldBundleFilename);
      }
    }
  }
  performance.mark("buildScriptFiles:revalidateEnd");

  // --- Ensure directories ---
  performance.mark("buildScriptFiles:mkdirStart");
  await Deno.mkdir(publicDir, { recursive: true });
  await Deno.mkdir(handlerDir, { recursive: true });
  await Deno.mkdir(stylesDir, { recursive: true });
  performance.mark("buildScriptFiles:mkdirEnd");

  // --- Log changes (non-fresh only) ---
  if (!fresh) {
    if (changedHandlerKeys.size > 0) {
      console.log("Handlers that changed this run:");
      for (const key of changedHandlerKeys) {
        console.log(`  ${key}`);
      }
    }
    if (changedStyleKeys.size > 0) {
      console.log("Styles that changed this run:");
      for (const key of changedStyleKeys) {
        console.log(`  ${key}`);
      }
    }
  }

  // --- Build handlers ---
  performance.mark("buildScriptFiles:handlersStart");
  const handlerFiles = await buildHandlers(handlerDir, { fresh });
  performance.mark("buildScriptFiles:handlersEnd");

  // --- Transpile client files (opt-in) ---
  performance.mark("buildScriptFiles:clientStart");
  const clientBuiltFiles = shouldTranspileClient
    ? await transpileClientDir(clientDir, publicDir)
    : [];
  performance.mark("buildScriptFiles:clientEnd");

  const allFiles = [...handlerFiles, ...clientBuiltFiles];
  console.log("Handler files: ", allFiles.length);

  // --- Build styles ---
  performance.mark("buildScriptFiles:stylesStart");
  const allStyleFiles = await buildStyles(stylesDir, { fresh });
  performance.mark("buildScriptFiles:stylesEnd");

  console.log("Style files: ", allStyleFiles.length);

  // --- Cleanup stale files (skip in fresh mode — nothing to remove) ---
  performance.mark("buildScriptFiles:cleanupStart");
  if (!fresh) {
    await cleanupStaleFiles(handlerDir, stylesDir, allFiles, allStyleFiles);
  }
  performance.mark("buildScriptFiles:cleanupEnd");

  // --- Persist cache so subsequent --prod runs can trust it ---
  cache.save();

  // --- Stop esbuild worker so the process can exit cleanly ---
  await esbuild.stop();

  performance.mark("buildScriptFiles:end");

  performance.measure(
    "buildScriptFiles:revalidate",
    "buildScriptFiles:revalidateStart",
    "buildScriptFiles:revalidateEnd",
  );
  performance.measure(
    "buildScriptFiles:mkdir",
    "buildScriptFiles:mkdirStart",
    "buildScriptFiles:mkdirEnd",
  );
  performance.measure(
    "buildScriptFiles:handlers",
    "buildScriptFiles:handlersStart",
    "buildScriptFiles:handlersEnd",
  );
  performance.measure(
    "buildScriptFiles:client",
    "buildScriptFiles:clientStart",
    "buildScriptFiles:clientEnd",
  );
  performance.measure(
    "buildScriptFiles:styles",
    "buildScriptFiles:stylesStart",
    "buildScriptFiles:stylesEnd",
  );
  performance.measure(
    "buildScriptFiles:cleanup",
    "buildScriptFiles:cleanupStart",
    "buildScriptFiles:cleanupEnd",
  );
  performance.measure(
    "buildScriptFiles:total",
    "buildScriptFiles:begin",
    "buildScriptFiles:end",
  );

  // Startup-level marks (measures are created by logStartupPerformanceSummary)
  performance.mark("startup:buildScriptFilesEnd");
}

async function transpileClientFile(
  fileName: string,
  clientDir: string,
  publicDir: string,
): Promise<string> {
  const inPath = `${clientDir}/${fileName}`;
  const outBaseName = fileName.replace(/\.(ts|tsx)$/i, "");
  const outPath = `${publicDir}/${outBaseName}.js`;

  const sourceStat = await Deno.stat(inPath);
  const sourceMtimeMs = sourceStat.mtime?.getTime() ?? null;

  const existingOutStat = await Deno.stat(outPath).catch(() => null);
  const outMtimeMs = existingOutStat?.mtime?.getTime() ?? null;

  // mtime-based cache: if output exists and is newer/equal to source, skip.
  if (
    sourceMtimeMs !== null && outMtimeMs !== null &&
    outMtimeMs >= sourceMtimeMs
  ) {
    // console.log(`Client script unchanged, skipping: ${outPath}`);
    return outBaseName;
  }

  const inputCode = await Deno.readTextFile(inPath);
  const loader = fileName.toLowerCase().endsWith(".tsx") ? "tsx" : "ts";
  const result = await esbuild.transform(inputCode, {
    loader,
    format: "esm",
    target: ["esnext"],
    sourcemap: false,
  });

  // Convert .ts/.tsx imports to .js (esbuild transform doesn't handle this)
  const outputCode = result.code.replace(
    /(from\s+["'])([^"']+)(\.tsx?)(["'])/g,
    "$1$2.js$4",
  );

  await Deno.writeTextFile(outPath, outputCode);
  console.log(`Client script written: ${outPath}`);
  return outBaseName;
}
