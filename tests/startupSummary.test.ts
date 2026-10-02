import { assertEquals, assertStringIncludes } from "@std/assert";
import { logStartupPerformanceSummary } from "../startupPerformanceSummary.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("startup summary reports import and route marks generically", async () => {
  performance.clearMarks();
  performance.clearMeasures();
  performance.mark("startup:begin");
  await sleep(8);
  performance.mark("import:hono:done");
  await sleep(8);
  performance.mark("import:my-app-modules:done");
  performance.mark("startup:importsComplete");
  performance.mark("startup:appCreated");
  performance.mark("import:route:patients:start");
  await sleep(3);
  performance.mark("import:route:patients:end");
  performance.mark("import:route:instant:start");
  performance.mark("import:route:instant:end");
  performance.mark("startup:routesRegistered");

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    logStartupPerformanceSummary();
  } finally {
    console.log = originalLog;
    performance.clearMarks();
    performance.clearMeasures();
  }
  const output = lines.join("\n");
  assertStringIncludes(output, "[startup] total init:");
  assertStringIncludes(output, "import breakdown");
  assertStringIncludes(output, "hono:");
  assertStringIncludes(output, "my-app-modules:");
  assertStringIncludes(output, "route breakdown");
  assertStringIncludes(output, "patients:");
  // Routes faster than a millisecond are omitted.
  assertEquals(output.includes("instant"), false);
  assertStringIncludes(output, "built on demand by tiny.imports()");
  assertEquals(output.includes("engage()"), false);
});
