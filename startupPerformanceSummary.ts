// Mark startup begin as early as possible
performance.mark("startup:begin");

/**
 * Creates startup-level performance measures from marks placed throughout
 * the codebase. Safe to call multiple times — skips measures that already exist
 * or whose marks are missing.
 */
function createStartupMeasures() {
  const hasMark = (name: string) =>
    performance.getEntriesByName(name, "mark").length > 0;
  const hasMeasure = (name: string) =>
    performance.getEntriesByName(name, "measure").length > 0;

  const measureIfNew = (
    name: string,
    startMark: string,
    endMark: string,
  ) => {
    if (hasMark(startMark) && hasMark(endMark) && !hasMeasure(name)) {
      performance.measure(name, startMark, endMark);
    }
  };

  // Use the moment this function is called as the end mark when no explicit end exists
  if (!hasMark("startup:end")) {
    performance.mark("startup:end");
  }

  measureIfNew("startup:imports", "startup:begin", "startup:importsComplete");
  measureIfNew(
    "startup:createApp",
    "startup:importsComplete",
    "startup:appCreated",
  );
  measureIfNew(
    "startup:routes",
    "startup:appCreated",
    "startup:routesRegistered",
  );
  measureIfNew(
    "startup:buildScriptFiles",
    "startup:buildScriptFilesStart",
    "startup:buildScriptFilesEnd",
  );
  measureIfNew("startup:total", "startup:begin", "startup:end");
}

/**
 * Logs a formatted startup performance summary to the console.
 *
 * Works in both modes:
 * - **Build mode**: `buildScriptFiles()` was called — shows full build breakdown
 * - **Dev mode**: lazy loading via `engage()` — shows imports/routes only,
 *   build happens per-request on first `engage()` call
 *
 * @example
 * ```ts
 * import { logStartupPerformanceSummary } from "./startupPerformanceSummary.ts";
 * // ... startup code ...
 * logStartupPerformanceSummary();
 * ```
 */
export function logStartupPerformanceSummary() {
  // Create measures from marks (handles both eager-build and lazy-build modes)
  createStartupMeasures();

  const getLastMeasure = (name: string): PerformanceMeasure | undefined => {
    const entries = performance.getEntriesByName(name, "measure");
    return entries.length ? (entries.at(-1) as PerformanceMeasure) : undefined;
  };

  const getMark = (name: string): PerformanceMark | undefined => {
    const entries = performance.getEntriesByName(name, "mark");
    return entries.length ? (entries.at(-1) as PerformanceMark) : undefined;
  };

  const fmtMs = (ms: number | undefined): string =>
    ms === undefined ? "n/a" : ms.toFixed(2);

  const pctOf = (partMs: number | undefined, totalMs: number | undefined) => {
    if (partMs === undefined || totalMs === undefined || totalMs <= 0) {
      return "";
    }
    return ` (${((partMs / totalMs) * 100).toFixed(1)}%)`;
  };

  // Get the start time for calculating offsets from startup
  const startTime = getMark("startup:begin")?.startTime ?? 0;
  const getOffset = (markName: string): number | undefined => {
    const mark = getMark(markName);
    if (!mark) return undefined;
    return mark.startTime - startTime;
  };

  // Calculate delta between two marks
  const getDelta = (
    startMark: string,
    endMark: string,
  ): number | undefined => {
    const start = getOffset(startMark);
    const end = getOffset(endMark);
    if (start === undefined || end === undefined) return undefined;
    return end - start;
  };

  const totalMs = getLastMeasure("startup:total")?.duration;
  const importsMs = getLastMeasure("startup:imports")?.duration;
  const createAppMs = getLastMeasure("startup:createApp")?.duration;
  const routesMs = getLastMeasure("startup:routes")?.duration;
  const buildTotalMs = getLastMeasure("buildScriptFiles:total")?.duration;
  const buildRevalidateMs = getLastMeasure("buildScriptFiles:revalidate")
    ?.duration;
  const buildMkdirMs = getLastMeasure("buildScriptFiles:mkdir")?.duration;
  const buildHandlersMs = getLastMeasure("buildScriptFiles:handlers")?.duration;
  const buildClientMs = getLastMeasure("buildScriptFiles:client")?.duration;
  const buildStylesMs = getLastMeasure("buildScriptFiles:styles")?.duration;
  const buildCleanupMs = getLastMeasure("buildScriptFiles:cleanup")?.duration;

  const hasBuildPhase = buildTotalMs !== undefined;

  // Import timing - deltas between import marks
  // main.tsx imports (grouped by category)
  const mainTsxStartOffset = getOffset("import:main.tsx:start");
  const honoMs = getDelta("import:main.tsx:start", "import:hono:done");
  const middlewareMs = getDelta("import:hono:done", "import:middleware:done");
  const tinyToolsMs = getDelta(
    "import:middleware:done",
    "import:@tinytools/hono-tools:done",
  );

  // Time from startup:begin to main.tsx:start is ESM resolution of dependencies
  const esmResolutionMs = mainTsxStartOffset;

  // Time from @tinytools/hono-tools:done to importsComplete is app modules
  const appModulesMs = getDelta(
    "import:@tinytools/hono-tools:done",
    "startup:importsComplete",
  );

  const isLazy = Deno.args.includes("--lazy");
  const mode = hasBuildPhase ? "build" : isLazy ? "lazy" : "prod";
  console.log(`[startup] total init: ${fmtMs(totalMs)}ms  (${mode})`);
  console.log(`[startup] breakdown:`);
  console.log(
    `  ├─ imports: ${fmtMs(importsMs)}ms${pctOf(importsMs, totalMs)}`,
  );

  // Show import breakdown - only items >= 5ms
  const importItems: { name: string; ms: number | undefined }[] = [
    {
      name: "ESM dep resolution (dotenv, drizzle, better-auth)",
      ms: esmResolutionMs,
    },
    { name: "hono", ms: honoMs },
    { name: "middleware (compress, canAccessRoute + auth)", ms: middlewareMs },
    { name: "@tinytools/hono-tools", ms: tinyToolsMs },
    { name: "app modules", ms: appModulesMs },
  ];

  const significantImports = importItems.filter(
    (item) => item.ms !== undefined && item.ms >= 5,
  );
  if (significantImports.length > 0) {
    console.log(`  │  import breakdown (≥5ms):`);
    significantImports.forEach((item, index) => {
      const isLast = index === significantImports.length - 1;
      const prefix = isLast ? "└─" : "├─";
      console.log(
        `  │  ${prefix} ${item.name}: ${fmtMs(item.ms)}ms${
          pctOf(item.ms, importsMs)
        }`,
      );
    });
  }
  console.log(
    `  ├─ createApp: ${fmtMs(createAppMs)}ms${pctOf(createAppMs, totalMs)}`,
  );

  const lastConnector = hasBuildPhase ? "├─" : "└─";
  console.log(
    `  ${lastConnector} routes: ${fmtMs(routesMs)}ms${
      pctOf(routesMs, totalMs)
    }`,
  );

  // Show individual route timings (≥1ms, since routes are often quick individually)
  const routeMarks = performance
    .getEntriesByType("mark")
    .filter(
      (m) => m.name.startsWith("import:route:") && m.name.endsWith(":start"),
    )
    .map((startMark) => {
      const routeName = startMark.name
        .replace("import:route:", "")
        .replace(":start", "");
      const endMark = getMark(`import:route:${routeName}:end`);
      const ms = endMark ? endMark.startTime - startMark.startTime : undefined;
      return { name: routeName, ms };
    })
    .filter((r) => r.ms !== undefined && r.ms >= 1)
    .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)); // Sort by slowest first

  if (routeMarks.length > 0) {
    const routeTreePrefix = hasBuildPhase ? "  │" : "   ";
    console.log(`${routeTreePrefix}  route breakdown (≥1ms):`);
    routeMarks.forEach((route, index) => {
      const isLast = index === routeMarks.length - 1;
      const prefix = isLast ? "└─" : "├─";
      console.log(
        `${routeTreePrefix}  ${prefix} /${route.name}: ${fmtMs(route.ms)}ms${
          pctOf(route.ms, routesMs)
        }`,
      );
    });
  }

  if (hasBuildPhase) {
    console.log(
      `  └─ buildScriptFiles: ${fmtMs(buildTotalMs)}ms${
        pctOf(buildTotalMs, totalMs)
      }`,
    );
    console.log(
      `     ├─ revalidate: ${fmtMs(buildRevalidateMs)}ms${
        pctOf(buildRevalidateMs, buildTotalMs)
      }`,
    );
    console.log(
      `     ├─ mkdir: ${fmtMs(buildMkdirMs)}ms${
        pctOf(buildMkdirMs, buildTotalMs)
      }`,
    );
    console.log(
      `     ├─ handlers: ${fmtMs(buildHandlersMs)}ms${
        pctOf(buildHandlersMs, buildTotalMs)
      }`,
    );
    console.log(
      `     ├─ client: ${fmtMs(buildClientMs)}ms${
        pctOf(buildClientMs, buildTotalMs)
      }`,
    );
    console.log(
      `     ├─ styles: ${fmtMs(buildStylesMs)}ms${
        pctOf(buildStylesMs, buildTotalMs)
      }`,
    );
    console.log(
      `     └─ cleanup: ${fmtMs(buildCleanupMs)}ms${
        pctOf(buildCleanupMs, buildTotalMs)
      }`,
    );
  } else {
    console.log(
      `  (handlers & styles build lazily on first request via engage())`,
    );
  }
}
