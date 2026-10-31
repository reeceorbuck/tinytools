import { readFile } from "node:fs/promises";

// deno-lint-ignore no-explicit-any
type EsbuildAPI = any;

let api: EsbuildAPI | undefined;

/**
 * Get an initialized esbuild API. Uses native esbuild (fast) locally,
 * falls back to WASM browser build if child_process is unavailable
 * (e.g. hosted/containerized Deno environments).
 */
export async function getEsbuild(): Promise<EsbuildAPI> {
  if (api) return api;

  try {
    const native = await import("esbuild");
    // Verify native mode actually works (child_process may be broken)
    await native.transform("", { loader: "ts" });
    api = native;
  } catch {
    // Fall back to the browser WASM build (no child_process needed)
    console.log("Native esbuild unavailable, falling back to esbuild-wasm");
    // A literal specifier, so JSR rewrites it through the import map.
    // @ts-ignore: tsc (the npm build) finds no types for the browser build
    const browserModule = await import("esbuild-wasm/lib/browser.min.js");
    const browser = browserModule.default ?? browserModule;
    const wasmUrl = new URL(import.meta.resolve("esbuild-wasm/esbuild.wasm"));
    // Node's fetch does not read file: URLs
    const wasmBytes = wasmUrl.protocol === "file:"
      ? new Uint8Array(await readFile(wasmUrl))
      : await (await fetch(wasmUrl)).arrayBuffer();
    const wasmModule = await WebAssembly.compile(wasmBytes);
    await browser.initialize({ wasmModule, worker: false });
    api = browser;
  }

  return api;
}
