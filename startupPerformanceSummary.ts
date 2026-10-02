// Mark startup begin as early as possible: this module is imported first by mod.ts.
performance.mark("startup:begin");

/**
 * Startup timing summary for @tinytools/hono-tools.
 *
 * Applications place `performance.mark()` calls at the points below and call
 * {@link logStartupPerformanceSummary} once the server is listening:
 *
 * - `startup:importsComplete` after all imports.
 * - `startup:routesRegistered` after routes are mounted (`startup:appCreated`
 *   is placed by `tiny.middleware.core()`).
 * - `import:<name>:done` after any import whose cost is worth showing; each
 *   is reported as the time since the previous `import:*:done` mark (or
 *   `startup:begin`).
 * - `import:route:<name>:start` / `import:route:<name>:end` around route
 *   module imports to show a per-route breakdown.
 *
 * `buildScriptFiles()` adds its own `buildScriptFiles:*` measures.
 *
 * @module
 */

const IMPORT_DONE_PATTERN = /^import:(.+):done$/;
const ROUTE_START_PATTERN = /^import:route:(.+):start$/;

/** Create the startup measures from whichever marks are present. */
function createStartupMeasures(): void {
  const hasMark = (name: string) =>
    performance.getEntriesByName(name, "mark").length > 0;
  const hasMeasure = (name: string) =>
    performance.getEntriesByName(name, "measure").length > 0;

  const measureIfNew = (name: string, startMark: string, endMark: string) => {
    if (hasMark(startMark) && hasMark(endMark) && !hasMeasure(name)) {
      performance.measure(name, startMark, endMark);
    }
  };

  if (!hasMark("startup:end")) performance.mark("startup:end");

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

function lastMeasure(name: string): number | undefined {
  return performance.getEntriesByName(name, "measure").at(-1)?.duration;
}

function lastMark(name: string): PerformanceEntry | undefined {
  return performance.getEntriesByName(name, "mark").at(-1);
}

function formatMs(ms: number | undefined): string {
  return ms === undefined ? "n/a" : `${ms.toFixed(2)}ms`;
}

function percentOf(
  part: number | undefined,
  total: number | undefined,
): string {
  if (part === undefined || total === undefined || total <= 0) return "";
  return ` (${((part / total) * 100).toFixed(1)}%)`;
}

type TimedItem = { name: string; ms: number };

/** `import:<name>:done` marks as durations since the previous one. */
function importBreakdown(): TimedItem[] {
  const begin = lastMark("startup:begin")?.startTime ?? 0;
  const done = performance.getEntriesByType("mark")
    .filter((mark) => IMPORT_DONE_PATTERN.test(mark.name))
    .sort((a, b) => a.startTime - b.startTime);
  let previous = begin;
  return done.map((mark) => {
    const ms = mark.startTime - previous;
    previous = mark.startTime;
    return { name: IMPORT_DONE_PATTERN.exec(mark.name)![1], ms };
  });
}

/** `import:route:<name>:start`/`:end` pairs, slowest first. */
function routeBreakdown(): TimedItem[] {
  return performance.getEntriesByType("mark")
    .flatMap((start) => {
      const name = ROUTE_START_PATTERN.exec(start.name)?.[1];
      const end = name && lastMark(`import:route:${name}:end`);
      return name && end ? [{ name, ms: end.startTime - start.startTime }] : [];
    })
    .sort((a, b) => b.ms - a.ms);
}

function logTree(
  items: TimedItem[],
  indent: string,
  total: number | undefined,
  minimumMs: number,
): void {
  const shown = items.filter((item) => item.ms >= minimumMs);
  shown.forEach((item, index) => {
    const prefix = index === shown.length - 1 ? "└─" : "├─";
    console.log(
      `${indent}${prefix} ${item.name}: ${formatMs(item.ms)}${
        percentOf(item.ms, total)
      }`,
    );
  });
}

/**
 * Logs a formatted startup timing summary. Works whether assets were built
 * up front with `buildScriptFiles()` or are built lazily by `tiny.imports()`.
 */
export function logStartupPerformanceSummary(): void {
  createStartupMeasures();

  const totalMs = lastMeasure("startup:total");
  const importsMs = lastMeasure("startup:imports");
  const createAppMs = lastMeasure("startup:createApp");
  const routesMs = lastMeasure("startup:routes");
  const buildTotalMs = lastMeasure("buildScriptFiles:total");
  const hasBuildPhase = buildTotalMs !== undefined;

  const flags = process.argv.slice(2);
  const mode = hasBuildPhase
    ? "build"
    : flags.includes("--none")
    ? "none"
    : flags.includes("--lazy")
    ? "lazy"
    : "prod";

  console.log(`[startup] total init: ${formatMs(totalMs)} (${mode})`);
  console.log("[startup] breakdown:");
  console.log(
    `  ├─ imports: ${formatMs(importsMs)}${percentOf(importsMs, totalMs)}`,
  );
  const imports = importBreakdown();
  if (imports.some((item) => item.ms >= 5)) {
    console.log("  │  import breakdown (≥5ms):");
    logTree(imports, "  │  ", importsMs, 5);
  }
  console.log(
    `  ├─ createApp: ${formatMs(createAppMs)}${
      percentOf(createAppMs, totalMs)
    }`,
  );
  console.log(
    `  ${hasBuildPhase ? "├─" : "└─"} routes: ${formatMs(routesMs)}${
      percentOf(routesMs, totalMs)
    }`,
  );
  const routes = routeBreakdown();
  if (routes.some((item) => item.ms >= 1)) {
    const indent = hasBuildPhase ? "  │  " : "     ";
    console.log(`${indent}route breakdown (≥1ms):`);
    logTree(routes, indent, routesMs, 1);
  }

  if (!hasBuildPhase) {
    console.log(
      "  (handlers and styles are built on demand by tiny.imports())",
    );
    return;
  }
  console.log(
    `  └─ buildScriptFiles: ${formatMs(buildTotalMs)}${
      percentOf(buildTotalMs, totalMs)
    }`,
  );
  logTree(
    ["revalidate", "mkdir", "handlers", "client", "styles", "cleanup"].flatMap(
      (phase) => {
        const ms = lastMeasure(`buildScriptFiles:${phase}`);
        return ms === undefined ? [] : [{ name: phase, ms }];
      },
    ),
    "     ",
    buildTotalMs,
    0,
  );
}
