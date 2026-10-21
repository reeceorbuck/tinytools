/**
 * A fresh build into `Deno.args[0]`, of an app that defines a `tiny.Signals`
 * collection when `Deno.args[1]` is "signals" and only handlers otherwise.
 * Never imports `signalTools` itself.
 */
import { Handlers, Signals } from "../../clientTools.ts";
import { buildScriptFiles } from "../../build.ts";
import { getEsbuild } from "../../esbuildInit.ts";

const [publicDir, kind] = Deno.args;
new Handlers(import.meta.url, {
  greet(this: HTMLElement) {
    this.textContent = "hi";
  },
});
if (kind === "signals") {
  new Signals(import.meta.url, ({ Signal }) => ({ count: new Signal(0) }));
}
await buildScriptFiles({ fresh: true, publicDir });
(await getEsbuild()).stop();
