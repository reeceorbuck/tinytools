/**
 * Pre-build script for package client files.
 * Transpiles client/*.ts → client/dist/*.js and generates a manifest.
 *
 * Run before publishing: deno task build:client
 */

import { getEsbuild } from "./esbuildInit.ts";
import type { Loader } from "esbuild";

type ClientSourceEntry = {
  file: Deno.DirEntry;
  logicalName: string;
  loader: Loader;
  sourceCode: string;
};

async function computeContentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

function parseContentHashFromOutName(outName: string): string | null {
  const match = outName.match(/\.([a-f0-9]{8})\.js$/);
  return match ? match[1] : null;
}

async function readExistingManifest(
  distDir: string,
): Promise<Record<string, string>> {
  try {
    const content = await Deno.readTextFile(`${distDir}/manifest.ts`);
    const match = content.match(
      /clientFileManifest\s*=\s*({[\s\S]*?})\s*as\s*const/,
    );
    if (!match) return {};
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}

async function writeTextFileIfChanged(
  path: string,
  content: string,
): Promise<boolean> {
  const existingContent = await Deno.readTextFile(path).catch(() => null);
  if (existingContent === content) {
    return false;
  }

  await Deno.writeTextFile(path, content);
  return true;
}

export async function buildPackageClientFiles(): Promise<void> {
  const clientDir = `${import.meta.dirname}/client`;
  const distDir = `${clientDir}/dist`;

  const packageConfig = JSON.parse(
    await Deno.readTextFile(new URL("./deno.json", import.meta.url)),
  ) as { version?: string };
  const packageVersion = typeof packageConfig.version === "string"
    ? packageConfig.version
    : "0.0.0";
  const normalizedVersion = packageVersion.replace(/[^a-zA-Z0-9.-]/g, "-");

  await Deno.mkdir(distDir, { recursive: true });

  const files = (await Array.fromAsync(Deno.readDir(clientDir)))
    .filter((entry) => entry.isFile)
    .filter((entry) =>
      entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
    );

  console.log(`Transpiling ${files.length} client files → client/dist/`);

  const sourceEntries = await Promise.all(files.map(async (file) => ({
    file,
    logicalName: file.name.replace(/\.(ts|tsx)$/i, ".js"),
    loader: (file.name.toLowerCase().endsWith(".tsx") ? "tsx" : "ts") as Loader,
    sourceCode: await Deno.readTextFile(`${clientDir}/${file.name}`),
  })));

  sourceEntries.sort((left, right) =>
    left.logicalName.localeCompare(right.logicalName)
  );

  // Transpile all files and compute per-file content hashes
  const esbuild = await getEsbuild();
  const transpiledEntries = await Promise.all(
    sourceEntries.map(async (entry) => {
      const result = await esbuild.transform(entry.sourceCode, {
        loader: entry.loader,
        format: "esm",
        target: ["esnext"],
        sourcemap: false,
      });
      // Normalize .ts/.tsx imports to .js before hashing
      const preRewriteCode = result.code.replace(
        /(from\s+["'])([^"']+)(\.tsx?)(["'])/g,
        "$1$2.js$4",
      );
      const contentHash = await computeContentHash(preRewriteCode);
      return { ...entry, transpiledCode: preRewriteCode, contentHash };
    }),
  );

  // Read existing manifest to preserve filenames for unchanged files
  const existingManifest = await readExistingManifest(distDir);

  // Determine output names: reuse existing name if content hash matches
  const manifestEntries = transpiledEntries.map((entry) => {
    const existingOutName = existingManifest[entry.logicalName];
    const existingHash = existingOutName
      ? parseContentHashFromOutName(existingOutName)
      : null;

    const outName = existingHash === entry.contentHash
      ? existingOutName!
      : entry.logicalName.replace(
        /\.js$/i,
        `.v${normalizedVersion}.${entry.contentHash}.js`,
      );

    return { ...entry, outName };
  });

  const manifest = Object.fromEntries(
    manifestEntries.map(({ logicalName, outName }) => [logicalName, outName]),
  ) as Record<string, string>;

  // Compute a combined build hash from all content hashes
  const buildHash = await computeContentHash(
    manifestEntries.map((e) => e.contentHash).join("\0"),
  );

  for (const { file, outName, transpiledCode } of manifestEntries) {
    // Rewrite local imports to use built filenames
    const outputCode = transpiledCode.replace(
      /(from\s+["'])(\.\/[^"']+\.js)(["'])/g,
      (_match: string, prefix: string, importPath: string, suffix: string) => {
        const importedLogicalName = importPath.slice(2);
        const importedBuiltName = manifest[importedLogicalName];

        if (!importedBuiltName) {
          return `${prefix}${importPath}${suffix}`;
        }

        return `${prefix}./${importedBuiltName}${suffix}`;
      },
    );

    const updated = await writeTextFileIfChanged(
      `${distDir}/${outName}`,
      outputCode,
    );
    console.log(
      updated
        ? `  ${file.name} → dist/${outName}`
        : `  ${file.name} unchanged (dist/${outName})`,
    );
  }

  const generatedFiles = new Set(manifestEntries.map(({ outName }) => outName));
  for await (const entry of Deno.readDir(distDir)) {
    if (
      entry.isFile &&
      entry.name.endsWith(".js") &&
      !generatedFiles.has(entry.name)
    ) {
      await Deno.remove(`${distDir}/${entry.name}`);
      console.log(`  removed stale dist/${entry.name}`);
    }
  }

  const manifestCode = [
    "// Auto-generated by buildClientFiles.ts — do not edit",
    `export const buildHash = ${JSON.stringify(buildHash)} as const;`,
    `export const clientFileManifest = ${
      JSON.stringify(manifest, null, 2)
    } as const;`,
    "export type ClientFile = keyof typeof clientFileManifest;",
    "export const clientFiles = Object.values(clientFileManifest) as readonly string[];",
    "export function getClientFileName(file: ClientFile): string {",
    "  return clientFileManifest[file];",
    "}",
    "",
  ].join("\n");
  const manifestUpdated = await writeTextFileIfChanged(
    `${distDir}/manifest.ts`,
    manifestCode,
  );
  console.log(
    manifestUpdated
      ? `  manifest.ts (${manifestEntries.length} files)`
      : `  manifest.ts unchanged (${manifestEntries.length} files)`,
  );

  esbuild.stop();
  console.log("Done.");
}

if (import.meta.main) {
  await buildPackageClientFiles();
}
