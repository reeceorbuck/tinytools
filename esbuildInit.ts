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
    const browserModule = await import("esbuild-wasm-browser");
    const browser = browserModule.default ?? browserModule;
    const wasmUrl = import.meta.resolve("esbuild-wasm/esbuild.wasm");
    const wasmModule = await WebAssembly.compile(
      await (await fetch(wasmUrl)).arrayBuffer(),
    );
    await browser.initialize({ wasmModule, worker: false });
    api = browser;
  }

  return api;
}
