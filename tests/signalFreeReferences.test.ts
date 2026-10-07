import { assertThrows } from "@std/assert";
import { cache, registeredClientTools, Signals } from "../clientTools.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

// In a file of its own: a free `fn` or `constants` makes the transpiler rename
// every local binding of that name in the module, which async definitions
// rely on keeping.
Deno.test("a factory referencing fn or constants without importing them explains why", () => {
  reset();
  try {
    assertThrows(
      () =>
        new Signals(import.meta.url, ({ Signal }) => ({
          // @ts-expect-error fn is not in scope here
          shade: new Signal(fn.value),
        })).evaluateUsingInitialValues(),
      TypeError,
      "only an async definition that imports it provides",
    );
    assertThrows(
      () =>
        new Signals(import.meta.url, ({ Signal }) => ({
          // @ts-expect-error constants is not in scope here
          shade: new Signal(constants.value),
        })).evaluateUsingInitialValues(),
      TypeError,
      "only an async definition that imports it provides",
    );
  } finally {
    reset();
  }
});
