import { tiny } from "../mod.ts";
import { signalTools } from "./signals_old.ts";

// New system is designed to have some parity with using imports inside a route or component
// Ideally would use option A, but option B with explicit spread of functions may be required
// This is because we use esbuild imoprt treeshaking to filter imports
// This wouldnt work if they are placed inside an fn object without some creativity

export const newTestTools = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(signalTools);
  return {
    someHandler: function (e: CommandEvent) {
      console.log("Some handler called, event: ", e);
      fn.useSignal(e);
    },
  };
});

export const newAltTestTools = new tiny.Handlers(
  import.meta.url,
  async () => {
    const { fn } = await tiny.imports(signalTools);
    const { useSignal } = fn;
    return {
      someHandler: function (e: CommandEvent) {
        console.log("Some handler called, event: ", e);
        useSignal(e);
      },
    };
  },
);

export const oldTools = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(signalTools);
  return {
    someHandler: function (e: CommandEvent) {
      console.log("Some handler called, event: ", e);
      fn.useSignal(e);
    },
  };
});
