performance.mark("import:@tiny-tools/hono/build:start");
/**
 * Build module for @tiny-tools/hono
 *
 * Provides build functionality for client functions and scoped styles.
 * This module uses esbuild to transpile TypeScript handlers to JavaScript.
 *
 * @module
 */

import * as esbuild from "esbuild";
performance.mark("import:esbuild:done");
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
}

/**
 * Builds all registered client functions and scoped styles to the public directory.
 * Also transpiles any client-side TypeScript files.
 *
 * @param options Build configuration options
 *
 * @example
 * ```ts
 * import { buildScriptFiles } from "@tiny-tools/hono/build";
 *
 * // Build with default options
 * await buildScriptFiles();
 *
 * // Build with custom directories
 * await buildScriptFiles({
 *   clientDir: "./src/client",
 *   publicDir: "./dist/public",
 * });
 * ```
 */
export async function buildScriptFiles(options: BuildOptions = {}) {
  const {
    clientDir = "./client",
    publicDir = "./public",
    handlerDir = `${publicDir}/handlers`,
    stylesDir = `${publicDir}/styles`,
  } = options;

  performance.mark("startup:buildScriptFilesStart");
  performance.mark("buildScriptFiles:begin");

  // Revalidate all handlers and styles. Since constructors no longer stat
  // source files, we do a full pass here to detect changes and update filenames.
  performance.mark("buildScriptFiles:revalidateStart");
  for (const handler of handlers.values()) {
    await handler.revalidateAndBuild(handlerDir);
  }
  for (const style of scopedStylesRegistry.values()) {
    style.revalidate();
  }
  performance.mark("buildScriptFiles:revalidateEnd");

  // Ensure the public directories exist
  performance.mark("buildScriptFiles:mkdirStart");
  await Deno.mkdir(publicDir, { recursive: true });
  await Deno.mkdir(handlerDir, { recursive: true });
  await Deno.mkdir(stylesDir, { recursive: true });
  performance.mark("buildScriptFiles:mkdirEnd");

  performance.mark("buildScriptFiles:scanStart");

  // Helper to scan a directory for client files
  async function scanClientDir(
    dir: string,
  ): Promise<{ dir: string; files: Deno.DirEntry[] }> {
    try {
      const files = (await Array.fromAsync(Deno.readDir(dir)))
        .filter((entry) => entry.isFile)
        .filter((entry) =>
          entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
        );
      return { dir, files };
    } catch {
      return { dir, files: [] };
    }
  }

  // Scan user client dir for user-provided client scripts
  const userClientFiles = await scanClientDir(clientDir);

  performance.mark("buildScriptFiles:scanEnd");

  if (userClientFiles.files.length > 0) {
    console.log(
      "User client files to process:",
      userClientFiles.files.map((s) => s.name),
    );
  }

  // Log any changed handlers for debugging
  if (changedHandlerKeys.size > 0) {
    console.log("Handlers that changed this run:");
    for (const key of changedHandlerKeys) {
      console.log(`  ${key}`);
    }
  }

  // Log any changed styles for debugging
  if (changedStyleKeys.size > 0) {
    console.log("Styles that changed this run:");
    for (const key of changedStyleKeys) {
      console.log(`  ${key}`);
    }
  }

  performance.mark("buildScriptFiles:handlersStart");
  const handlerFiles = await Promise.all(
    [...handlers.values()].map(async (handler) => {
      const { filename } = handler;
      // console.log("Registered handler: ", filename);

      const fileExists = await Deno.stat(`${handlerDir}/${filename}.js`)
        .then(() => true)
        .catch(() => false);

      // Check if we need to rebuild due to dependency changes
      const needsRebuildForDeps = handler.needsRebuildDueToDependencyChange();

      if (fileExists && !needsRebuildForDeps) {
        // console.log(
        //   `File for handler ${filename} already exists, skipping build.`,
        // );
        return filename;
      }

      if (needsRebuildForDeps) {
        console.log(
          `Rebuilding handler ${filename} because a dependency changed.`,
        );
      }

      console.log(`Building file for handler:`, handler.buildCode);
      const functionCode = await handler.buildCode();
      return Deno.writeTextFile(
        `${handlerDir}/${filename}.js`,
        functionCode,
      ).then(() => {
        console.log(`Handler file written: ${handlerDir}/${filename}.js`);
        return filename;
      });
    }),
  );
  performance.mark("buildScriptFiles:handlersEnd");

  performance.mark("buildScriptFiles:clientStart");
  // Transpile user-provided client TS files
  const clientBuiltFiles = await Promise.all(
    userClientFiles.files.map((entry) =>
      transpileClientFile(entry.name, userClientFiles.dir, publicDir)
    ),
  );
  performance.mark("buildScriptFiles:clientEnd");

  const files = [...handlerFiles, ...clientBuiltFiles];

  console.log("Handler files: ", files.length);

  // Build bundled style files (one file per ClientTools instance)
  performance.mark("buildScriptFiles:stylesStart");
  const styleFiles = await Promise.all(
    [...styleBundleRegistry.entries()].map(
      async ([bundleFilename, styles]) => {
        const filePath = `${stylesDir}/${bundleFilename}.css`;

        const fileExists = await Deno.stat(filePath)
          .then(() => true)
          .catch(() => false);

        // Check if any constituent style changed
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

        const cssContent = buildLayeredCssContent(styles);
        return Deno.writeTextFile(filePath, cssContent).then(() => {
          console.log(
            `Style bundle written: ${filePath} (${styles.length} styles)`,
          );
          return bundleFilename;
        });
      },
    ),
  );

  // Also build individual global style files (not bundled)
  const globalStyleFiles = await Promise.all(
    [...scopedStylesRegistry.values()]
      .filter((style) => {
        // Only process styles not covered by any bundle
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

        const fileExists = await Deno.stat(filePath)
          .then(() => true)
          .catch(() => false);

        const styleKey = sourceFileUrl ? `${sourceFileUrl}::${styleName}` : "";
        const styleChanged = styleKey && changedStyleKeys.has(styleKey);

        if (fileExists && !styleChanged) {
          return filename;
        }

        const cssContent = buildLayeredCssContent([style]);
        return Deno.writeTextFile(filePath, cssContent).then(() => {
          console.log(`Global style file written: ${filePath}`);
          return filename;
        });
      }),
  );

  const allStyleFiles = [...styleFiles, ...globalStyleFiles];
  performance.mark("buildScriptFiles:stylesEnd");

  console.log("Style files: ", allStyleFiles.length);

  // Clean up handler files that are no longer registered
  performance.mark("buildScriptFiles:cleanupStart");
  for await (const dirEntry of Deno.readDir(handlerDir)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".js")) {
      const fileName = dirEntry.name.replace(/\.js$/, "");
      if (!files.includes(fileName)) {
        console.log("Removing handler file: ", dirEntry.name);
        await Deno.remove(`${handlerDir}/${dirEntry.name}`);
      }
    }
  }

  // Clean up style files that are no longer registered
  for await (const dirEntry of Deno.readDir(stylesDir)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".css")) {
      const fileName = dirEntry.name.replace(/\.css$/, "");
      if (!allStyleFiles.includes(fileName)) {
        console.log("Removing style file: ", dirEntry.name);
        await Deno.remove(`${stylesDir}/${dirEntry.name}`);
      }
    }
  }

  performance.mark("buildScriptFiles:cleanupEnd");
  performance.mark("buildScriptFiles:end");

  performance.measure(
    "buildScriptFiles:mkdir",
    "buildScriptFiles:mkdirStart",
    "buildScriptFiles:mkdirEnd",
  );
  performance.measure(
    "buildScriptFiles:scan",
    "buildScriptFiles:scanStart",
    "buildScriptFiles:scanEnd",
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
