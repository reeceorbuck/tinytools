/**
 * Finds `tiny.imports()` arguments nothing reads, which refactors tend to
 * leave behind (and whose bundles a page then loads for nothing). Off in
 * prod mode.
 *
 * - In a request, each call site's `fn`, `styled`, `signal`, `template`,
 *   `constants` and `component` note which collection every name read comes
 *   from, across all requests since the server started. A collection read
 *   only on some branch counts as unused until that branch renders, so this
 *   is a report to ask for (`logUnusedImports()`), not a warning.
 * - In a `Handlers` or `Signals` definition, the shipped source is searched
 *   for each imported name once it is defined, so that check is warned about
 *   at once.
 *
 * @module
 */

/** One `tiny.imports()` argument, as the report names it. */
export type ImportedCollection = {
  /** What identifies the collection across calls: the collection itself. */
  key: object;
  /** `Handlers in DatePicker.tsx (adoptInput, showDate, …)`. */
  label: string;
  /** Every name it provides. */
  names: readonly string[];
  /**
   * The `tiny.imports()` result it is read through (`fn`, `signal`,
   * `template` or `constants`), if any: shipped source passing that along
   * whole (`helper(constants)`) may read any name, so counts as using it.
   */
  accessor?: string;
};

/** A call site and the collections it imports that nothing has read. */
export type UnusedImports = {
  /** `file:///…/Page.tsx:12:34`, where `tiny.imports()` is called. */
  site: string;
  /** Labels of the unused collections. */
  unused: string[];
  /** Whether this came from the shipped source of a definition. */
  definition: boolean;
};

type SiteRecord = {
  definition: boolean;
  collections: Map<object, { label: string; used: boolean }>;
};

const sites = new Map<string, SiteRecord>();
/** This file and clientTools, as `.ts` (JSR) or compiled `.js` (npm). */
const ownFiles = [
  import.meta.url,
  import.meta.url.replace(/importUsage(\.[jt]s)$/, "clientTools$1"),
];

/** The location of the code calling `tiny.imports()`, if the stack shows it. */
export function importCallSite(): string | undefined {
  const lines = new Error().stack?.split("\n").slice(1) ?? [];
  for (const line of lines) {
    if (ownFiles.some((file) => line.includes(file))) continue;
    // A URL, or the plain path some runtimes and loaders (tsx) report.
    const match =
      /(?:\(|at )((?:(?:file|https?|jsr):[^\s()]+|[A-Za-z]:\\[^()]+|\/[^()]+):\d+:\d+)\)?\s*$/
        .exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function siteRecord(
  site: string,
  collections: readonly ImportedCollection[],
  definition: boolean,
): SiteRecord {
  let record = sites.get(site);
  if (!record) {
    record = { definition, collections: new Map() };
    sites.set(site, record);
  }
  for (const { key, label } of collections) {
    if (!record.collections.has(key)) {
      record.collections.set(key, { label, used: false });
    }
  }
  return record;
}

/**
 * Records a request-time call's collections; the returned function marks one
 * as read.
 */
export function trackImports(
  site: string,
  collections: readonly ImportedCollection[],
): (key: object | undefined) => void {
  const record = siteRecord(site, collections, false);
  return (key) => {
    const entry = key && record.collections.get(key);
    if (entry) entry.used = true;
  };
}

/** Whether `source` reads `name` as a property (`.name`). */
function readsProperty(source: string, name: string): boolean {
  const escaped = name.replace(/[$]/g, "\\$");
  return new RegExp(`\\.\\s*${escaped}(?![$\\w])`).test(source);
}

/** Whether `source` uses `identifier` as a value, not to read a property. */
function passesWhole(source: string, identifier: string): boolean {
  return new RegExp(`(?<![$\\w.])${identifier}(?![$\\w]|\\s*\\??\\.)`)
    .test(source);
}

/**
 * Checks a definition's imports against the source it ships: a collection
 * none of whose names appears as a property read (`.name`), and whose
 * accessor is not passed along whole, is unused. Warns about the unused
 * ones, and keeps them for `unusedImports()`.
 */
export function checkDefinitionImports(
  imports: readonly { site: string; collections: ImportedCollection[] }[],
  source: string,
): void {
  for (const { site, collections } of imports) {
    const record = siteRecord(site, collections, true);
    const unused: string[] = [];
    for (const { key, label, names, accessor } of collections) {
      const used = names.some((name) => readsProperty(source, name)) ||
        (!!accessor && passesWhole(source, accessor));
      record.collections.get(key)!.used ||= used;
      if (!used) unused.push(label);
    }
    if (unused.length) {
      console.warn(
        `[tiny-tools] tiny.imports() at ${site} imports what its handlers never use:\n${
          unused.map((label) => `  - ${label}`).join("\n")
        }`,
      );
    }
  }
}

/**
 * Every call site with collections nothing has read so far. Request-time
 * sites count every request since the server started, so visit the pages
 * (and their variants) first.
 */
export function unusedImports(): UnusedImports[] {
  return [...sites].flatMap(([site, record]) => {
    const unused = [...record.collections.values()]
      .filter(({ used }) => !used)
      .map(({ label }) => label);
    return unused.length
      ? [{ site, unused, definition: record.definition }]
      : [];
  });
}

/** Prints `unusedImports()`, one call site at a time. */
export function logUnusedImports(): void {
  const found = unusedImports();
  if (!found.length) {
    console.log("[tiny-tools] No unused tiny.imports() found.");
    return;
  }
  console.warn(
    `[tiny-tools] tiny.imports() arguments nothing has read${
      found.some(({ definition }) => !definition)
        ? " (request-time sites count only the pages rendered so far)"
        : ""
    }:\n${
      found.map(({ site, unused }) =>
        `${site}\n${unused.map((label) => `  - ${label}`).join("\n")}`
      ).join("\n")
    }`,
  );
}

/** @internal Forgets every recorded site, for tests. */
export function resetImportUsage(): void {
  sites.clear();
}
