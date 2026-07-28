import { assertEquals, assertNotEquals } from "@std/assert";
import { computeClientOutputHashes } from "../buildClientFiles.ts";

Deno.test("client build - dependency changes invalidate importer output hash", async () => {
  const initial = await computeClientOutputHashes([
    {
      logicalName: "consumer.js",
      code: 'import { value } from "./dependency.js";\nconsole.log(value);',
    },
    { logicalName: "dependency.js", code: "export const value = 1;" },
  ]);
  const changed = await computeClientOutputHashes([
    {
      logicalName: "consumer.js",
      code: 'import { value } from "./dependency.js";\nconsole.log(value);',
    },
    { logicalName: "dependency.js", code: "export const value = 2;" },
  ]);

  assertNotEquals(initial.buildHash, changed.buildHash);
  assertNotEquals(
    initial.outputHashes.get("consumer.js"),
    changed.outputHashes.get("consumer.js"),
  );
  assertEquals(initial.outputHashes.size, 2);
});
