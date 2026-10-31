/**
 * Client tools for @tinytools/hono-tools.
 *
 * Defines the `tiny.Handlers`, `tiny.Signals` and `tiny.Styles`
 * collections, the `tiny.imports()` call that resolves them for a request, and
 * the on-disk cache that keeps generated asset filenames stable across
 * restarts. Handler bundling is in `clientFunctions.ts`, style scoping in
 * `scopedStyles.ts`, and the full build in `build.ts`.
 *
 * @module
 */

import type { JSX } from "./jsx-runtime.ts";
import {
  type ActivateScopedStyles,
  changedStyleKeys,
  mergeClassNames,
  normalizeCssWhitespace,
  normalizeScopedStyleInput,
  SCOPE_BOUNDARY_CLASS,
  ScopedStyleImpl,
  type ScopedStyleInput,
  styleBundleRegistry,
} from "./scopedStyles.ts";
import { tryGetContext } from "hono/context-storage";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  type InstanceGroup,
  type InstanceLevels,
  type InstanceSeed,
  InstanceSignalHandle,
  type InstanceSignals,
  type InternalSignalTools,
  type ReadonlySignal,
  type Signal,
  type SignalAccessors,
  type SignalAction,
  signalActions,
  signalClasses,
  type SignalConstant,
  type SignalConstants,
  type SignalDefinitions,
  type SignalInputs,
  type SignalTools,
  type SignalValue,
  type SignalValues,
} from "./signals.ts";
import {
  createHandlerReferences,
  createSignalReferences,
  type HandlerReference,
  type HandlerReferences,
  signalActionHandler,
  type SignalOrigin,
  type SignalReferences,
  type SignalRendering,
} from "./eventAttributes.ts";

// Import shared registries from registry modules
import {
  bundleByFilename,
  changedHandlerKeys,
  type ClientFunctionImpl,
  filesWithChangedHandlers,
  getImportRegistry,
  HandlerBundle,
} from "./clientFunctions.ts";
import {
  COMPONENT_ROOT_ATTRIBUTE,
  isMarkup,
  isTransparent,
  markedComponent,
  markResult,
} from "./componentScope.ts";
import { lifecycleRuntimePath } from "./lifecycleElement.ts";
import { signalToolsPrelude } from "./signalModules.ts";
import {
  checkDefinitionImports,
  importCallSite,
  type ImportedCollection,
  trackImports,
  unusedImports,
} from "./importUsage.ts";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  readdir,
  rm,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";

// ============================================================================
// Cache Management (combined for both functions and styles)
// ============================================================================

/**
 * Bump this when the hash algorithm changes to auto-invalidate caches.
 * History: 1 = Java-style 32-bit, 2 = FNV-1a 64-bit
 */
const HASH_ALGORITHM_VERSION = 2;

/** On-disk cache format. Version 4 stores handler filenames per bundle, not per handler. */
type ClientToolsCache = {
  version: 4;
  hashConfig: {
    handlerHashLength: number;
    styleHashLength: number;
    hashAlgorithm?: number;
  };
  files: Record<string, SourceFileCacheEntry>;
};

/** Generated filenames recorded for one source file, each ordered by instantiation. */
export type SourceFileCacheEntry = {
  mtimeMs: number;
  /** Bundle filenames under the `#bundle` key: `[filename, ...]` per bundle index. */
  handlers: Record<string, string[]>;
  /** Style filenames by style name: `[filename, ...]` per occurrence index. */
  styles: Record<string, string[]>;
};

/** A cache entry for a source file that has not been built yet. */
export function emptySourceFileCacheEntry(): SourceFileCacheEntry {
  return { mtimeMs: 0, handlers: {}, styles: {} };
}

const CACHE_DIR = "./.cache";
const CACHE_PATH = `${CACHE_DIR}/clientToolsCache.json`;
export const memoryBuild = process.argv.slice(2).includes("--none");
export const memoryAssets = new Map<string, string>();

export type NoContextToolUsageTracker = {
  readonly accessedHandlerFiles: Set<string>;
  readonly accessedStyleFiles: Set<string>;
  /** Custom tags rendered with lifecycle handlers, for `AssetTags` to declare. */
  readonly accessedLifecycleTags: Set<string>;
};

export interface ToolResolutionTarget {
  readonly _handlerFilenames: ReadonlyMap<string, string>;
  readonly _handlerDefinitions: ReadonlyMap<string, ClientFunctionImpl>;
  readonly _styleFilenames: ReadonlyMap<string, string>;
  readonly _styles: ReadonlyMap<string, ScopedStyleImpl>;
}

type ToolResolutionMode = "function" | "style";
type ToolUsageType = "handler" | "style";

let activeNoContextToolUsageTracker: NoContextToolUsageTracker | undefined;

export function createNoContextToolUsageTracker(): NoContextToolUsageTracker {
  return {
    accessedHandlerFiles: new Set<string>(),
    accessedStyleFiles: new Set<string>(),
    accessedLifecycleTags: new Set<string>(),
  };
}

function recordNoContextUsage(
  type: "handler" | "style",
  filename: string,
): void {
  if (!activeNoContextToolUsageTracker) return;
  if (type === "handler") {
    activeNoContextToolUsageTracker.accessedHandlerFiles.add(`${filename}.js`);
    return;
  }
  activeNoContextToolUsageTracker.accessedStyleFiles.add(`${filename}.css`);
}

/**
 * Records a handler file (`<bundle>.js`, possibly with a query) as one the
 * current render needs, for the request when one is active and otherwise for
 * the no-context tracker, so `AssetTags` emits a module script for it.
 */
export function recordHandlerFile(file: string): void {
  const context = tryGetContext<{
    Variables: { accessedHandlerFiles: Set<string> };
  }>();
  if (context) {
    context.get("accessedHandlerFiles")?.add(file);
    return;
  }
  activeNoContextToolUsageTracker?.accessedHandlerFiles.add(file);
}

/**
 * Records that the current render has a `<tagName>` element with lifecycle
 * handlers, for the request when one is active and otherwise for the
 * no-context tracker, so `AssetTags` declares the tag ahead of the markup
 * and the lifecycle runtime defines it (see `lifecycleElement.ts`).
 */
export function recordLifecycleTag(tagName: string): void {
  // A custom tag, or `is` name and extended tag (`custom-button:button`).
  if (!/^[a-z][.0-9_a-z-]*-[.0-9_a-z-]*(:[a-z][a-z0-9]*)?$/.test(tagName)) {
    throw new TypeError(
      `"${tagName}" is not a valid custom element name; it needs a hyphen and lower-case letters.`,
    );
  }
  const context = tryGetContext<{
    Variables: { accessedLifecycleTags: Set<string> };
  }>();
  if (context) {
    context.get("accessedLifecycleTags")?.add(tagName);
    return;
  }
  activeNoContextToolUsageTracker?.accessedLifecycleTags.add(tagName);
}

export function resolveToolAccessFromChain(
  toolsChain: readonly ToolResolutionTarget[],
  mode: ToolResolutionMode,
  prop: PropertyKey,
  onUsage?: (type: ToolUsageType, filename: string) => void,
): unknown {
  if (mode === "style" && prop === "mergeClasses") {
    return (...classNames: Array<string | null | undefined | false>) =>
      mergeClassNames(...classNames);
  }

  if (typeof prop !== "string") return undefined;

  for (let i = toolsChain.length - 1; i >= 0; i--) {
    const tools = toolsChain[i];
    const filenames = mode === "function"
      ? tools._handlerFilenames
      : tools._styleFilenames;

    if (!filenames.has(prop)) continue;

    const filename = filenames.get(prop);
    if (filename) {
      onUsage?.(mode === "function" ? "handler" : "style", filename);
    }

    // `<bundle>.<name>`, what `tt-handler-*` attributes carry.
    if (mode === "function") {
      return tools._handlerDefinitions.get(prop)?.reference;
    }

    const styleImpl = tools._styles.get(prop);
    if (!styleImpl) return undefined;
    return `${styleImpl.filename} ${SCOPE_BOUNDARY_CLASS}`;
  }

  return undefined;
}

export async function withNoContextToolUsageTracker<T>(
  tracker: NoContextToolUsageTracker,
  run: () => Promise<T> | T,
): Promise<T> {
  const previousTracker = activeNoContextToolUsageTracker;
  activeNoContextToolUsageTracker = tracker;
  try {
    return await run();
  } finally {
    activeNoContextToolUsageTracker = previousTracker;
  }
}

/**
 * Length of generated hash fragments used in client function/style filenames.
 * Increase this if your project grows and you want a lower collision risk.
 */
export const GENERATED_FILENAME_HASH_LENGTH = 5;
export const GENERATED_HANDLER_HASH_LENGTH = 5;
export const GENERATED_STYLE_HASH_LENGTH = 5;

const MAX_GENERATED_FILENAME_HASH_LENGTH = 8;
let generatedHandlerHashLength = GENERATED_HANDLER_HASH_LENGTH;
let generatedStyleHashLength = GENERATED_STYLE_HASH_LENGTH;

function clampGeneratedFilenameHashLength(value: number): number {
  return Math.max(
    1,
    Math.min(MAX_GENERATED_FILENAME_HASH_LENGTH, Math.trunc(value)),
  );
}

export function setGeneratedFilenameHashLength(length: number): void {
  setGeneratedHandlerHashLength(length);
  setGeneratedStyleHashLength(length);
}

export function setGeneratedHandlerHashLength(length: number): void {
  const previous = generatedHandlerHashLength;
  if (!Number.isFinite(length)) {
    generatedHandlerHashLength = GENERATED_HANDLER_HASH_LENGTH;
  } else {
    generatedHandlerHashLength = clampGeneratedFilenameHashLength(length);
  }

  if (previous !== generatedHandlerHashLength) {
    cache.resetHashDependentState();
  }
}

export function setGeneratedStyleHashLength(length: number): void {
  const previous = generatedStyleHashLength;
  if (!Number.isFinite(length)) {
    generatedStyleHashLength = GENERATED_STYLE_HASH_LENGTH;
  } else {
    generatedStyleHashLength = clampGeneratedFilenameHashLength(length);
  }

  if (previous !== generatedStyleHashLength) {
    cache.resetHashDependentState();
  }
}

function getCurrentHashConfig(): ClientToolsCache["hashConfig"] {
  return {
    handlerHashLength: generatedHandlerHashLength,
    styleHashLength: generatedStyleHashLength,
    hashAlgorithm: HASH_ALGORITHM_VERSION,
  };
}

function getHashLength(kind: "handler" | "style"): number {
  return kind === "handler"
    ? generatedHandlerHashLength
    : generatedStyleHashLength;
}

/** Full 64-bit FNV-1a hash as 16 hex characters. */
export function generateFullHash(str: string): string {
  const input = new TextEncoder().encode(str);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (const byte of input) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  return hash.toString(16).padStart(16, "0");
}

export function generateHash(
  str: string,
  kind: "handler" | "style" = "style",
): string {
  return generateFullHash(str).slice(0, getHashLength(kind));
}

export function generateHandlerHash(str: string): string {
  return generateHash(str, "handler");
}

export function generateStyleHash(str: string): string {
  return generateHash(str, "style");
}

/** Base URL for the current working directory, used to produce portable relative paths */
const CWD_URL = new URL(`file:///${process.cwd().replace(/\\/g, "/")}/`);

export function normalizeSourceFileUrl(
  sourceFileUrl: string | URL | undefined,
): string | undefined {
  if (!sourceFileUrl) return undefined;

  const raw = typeof sourceFileUrl === "string"
    ? sourceFileUrl
    : sourceFileUrl.toString();

  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    const absolute = url.toString();

    // Convert to cwd-relative path so the cache is portable across machines
    const cwdStr = CWD_URL.toString();
    if (absolute.startsWith(cwdStr)) {
      return absolute.slice(cwdStr.length);
    }
    return absolute;
  } catch {
    // Reject values that don't look like file paths (e.g. "true" from import.meta.main)
    const cleaned = raw.replace(/[?#].*$/, "");
    if (!/[/\\.]/.test(cleaned)) {
      return undefined;
    }
    return cleaned;
  }
}

/**
 * The readable prefix of a generated filename for an instance with no source
 * file: the first name it defines and what it defines (`resetType_handler`,
 * `size_signal`, `button_style`), or just the kind when it defines none.
 */
export function unsourcedFilenameBase(
  firstName: string | undefined,
  kind: "handler" | "signal" | "template" | "style",
): string {
  const name = firstName?.replace(/\W/g, "_");
  return name ? `${name}_${kind}` : kind;
}

let notedUnsourced = false;

/**
 * The source file only lets `--lazy` builds track each file's assets, so a
 * missing or unusable one is reported in that mode alone, once.
 */
function noteUnsourced(kind: string, sourceFileUrl: string | URL | undefined) {
  if (
    notedUnsourced || cache.trustCache || memoryBuild ||
    normalizeSourceFileUrl(sourceFileUrl)
  ) {
    return;
  }
  notedUnsourced = true;
  console.warn(
    `[tiny-tools] \x1b[33mNote:\x1b[0m a tiny.${kind} collection has no source file URL${
      sourceFileUrl === undefined
        ? ""
        : ` (received ${JSON.stringify(String(sourceFileUrl))})`
    }. ` +
      "Lazy mode cannot clean up the assets it replaces when its source changes. " +
      "Pass import.meta.url as the first argument to enable that.",
  );
}

/**
 * Splits a collection's arguments, `(definition)` or
 * `(import.meta.url, definition)`, into the source file and the definition.
 */
function sourceAndDefinition<Definition>(
  kind: string,
  args: readonly unknown[],
): [sourceFileUrl: string | URL | undefined, definition: Definition] {
  const [sourceFileUrl, definition] = args.length > 1
    ? args as [string | URL | undefined, Definition]
    : [undefined, args[0] as Definition];
  noteUnsourced(kind, sourceFileUrl);
  return [sourceFileUrl, definition];
}

function getFilenameHashFragment(filename: string): string {
  return filename.split("_").at(-1) ?? filename;
}

// ==========================================================================
// Cache manager for ClientTools.
// ==========================================================================

/**
 * Cache manager for ClientTools.
 * Handles loading, saving, and mtime tracking for client functions and scoped styles.
 */
class ClientToolsCacheManager {
  private dirty = false;
  private flushScheduled = false;
  private sourceFileMtimeMemo = new Map<string, number | null>();
  private filesWithMtimeChange = new Set<string>();

  /**
   * Per-source registry of every `ScopedStyleImpl` constructed against the
   * source file URL. When any style in a source file is observed to have
   * changed, every sibling style is revalidated before the source mtime is
   * committed to the cache, even when those siblings live in other `Styles`
   * instances sharing the same `import.meta.url`.
   */
  private stylesBySource = new Map<string, Set<unknown>>();

  /**
   * Handler/style impls already revalidated in the current detection
   * pass. Cleared by {@link beginChangeDetectionPass}. Used to short
   * circuit recursive sibling iteration so that each artifact is
   * processed at most once per pass regardless of which sibling started
   * the chain.
   */
  private processedHandlersThisPass = new WeakSet<object>();
  private processedStylesThisPass = new WeakSet<object>();

  /**
   * Refcount of in-flight change-detection passes. Concurrent callers
   * (e.g. `Promise.all` over multiple ClientTools' `ensureBuilt()`)
   * share a single logical pass: only the first call clears per-pass
   * state, and only the last call committing the pass persists source
   * mtimes. Without this, parallel passes would wipe each other's
   * `filesWithMtimeChange` + processed sets mid-fanout, causing sibling
   * handlers to observe `mtimeChanged=false` and skip filename
   * recomputation — leaving stale `.js` files on disk.
   */
  private passDepth = 0;

  /** Tracks instantiation order per file per name per kind (handler/style) */
  private nameOccurrences = new Map<string, number>();

  private hashConfig: ClientToolsCache["hashConfig"] = getCurrentHashConfig();

  /** When true, skip all file stat checks and trust cached filenames.
   *  This is the default. Pass --lazy to disable. */
  readonly trustCache: boolean;

  files: ClientToolsCache["files"] = {};

  constructor() {
    const lazyMode = process.argv.slice(2).includes("--lazy");
    this.trustCache = !lazyMode && !memoryBuild;

    if (memoryBuild) {
      console.log(
        "[tiny-tools] none mode active - generated assets stay in memory",
      );
      return;
    }

    // Load the cache from disk
    try {
      const text = readFileSync(CACHE_PATH, "utf-8");
      const parsed = JSON.parse(text);

      if (
        parsed && parsed.version === 4 && parsed.files &&
        typeof parsed.files === "object" && parsed.hashConfig
      ) {
        const loaded = parsed as ClientToolsCache;
        const loadedHashConfig = {
          handlerHashLength: clampGeneratedFilenameHashLength(
            loaded.hashConfig.handlerHashLength,
          ),
          styleHashLength: clampGeneratedFilenameHashLength(
            loaded.hashConfig.styleHashLength,
          ),
          hashAlgorithm: loaded.hashConfig.hashAlgorithm,
        };

        generatedHandlerHashLength = loadedHashConfig.handlerHashLength;
        generatedStyleHashLength = loadedHashConfig.styleHashLength;
        const current = getCurrentHashConfig();

        if (
          loadedHashConfig.handlerHashLength === current.handlerHashLength &&
          loadedHashConfig.styleHashLength === current.styleHashLength &&
          (loaded.hashConfig.hashAlgorithm ?? 0) === HASH_ALGORITHM_VERSION
        ) {
          this.hashConfig = loadedHashConfig;
          this.files = loaded.files;
        }
      }
    } catch (e) {
      // deno-lint-ignore no-explicit-any
      if ((e as any)?.code === "ENOENT") {
        // no cache file yet — expected on first run
      } else {
        console.warn("[tiny-tools] failed to load cache:", e);
      }
    }

    if (this.trustCache && Object.keys(this.files).length === 0) {
      console.warn(
        "[tiny-tools] prod mode active but no valid cache found. " +
          "Run a build first. Falling back to lazy mode.",
      );
      (this as { trustCache: boolean }).trustCache = false;
    }

    if (this.trustCache) {
      console.log(
        "[tiny-tools] \x1b[32mprod mode active\x1b[0m — cached handlers trusted, no builds will run during requests",
      );
    } else {
      console.log(
        "[tiny-tools] \x1b[33mlazy mode active\x1b[0m — handlers will be built/revalidated on demand",
      );
    }
  }

  /** Clear cached hash-dependent filenames after hash config changes. */
  resetHashDependentState(): void {
    this.files = {};
    this.hashConfig = getCurrentHashConfig();
    this.resetTransientState();
    this.markDirty();
  }

  /**
   * Forget everything a process restart would forget: instantiation
   * counters, mtime memos, per-pass trackers and sibling registries. The
   * persisted `files` map and hash config are kept, as they are reloaded
   * from disk. Used by tests to simulate `deno --watch` restarting the
   * server.
   */
  resetTransientState(): void {
    this.sourceFileMtimeMemo.clear();
    this.filesWithMtimeChange.clear();
    this.nameOccurrences.clear();
    this.stylesBySource.clear();
    this.processedHandlersThisPass = new WeakSet();
    this.processedStylesThisPass = new WeakSet();
    this.passDepth = 0;
  }

  /**
   * Begin a change-detection pass. Refcounted: nested/concurrent callers
   * participate in the same logical pass so that per-pass state
   * (`filesWithMtimeChange`, processed sets, mtime memo) is cleared
   * exactly once on entry and preserved for every participant until the
   * matching {@link commitPendingSourceMtimes} drops the count to zero.
   */
  beginChangeDetectionPass(): void {
    if (this.passDepth === 0) {
      this.sourceFileMtimeMemo.clear();
      this.filesWithMtimeChange.clear();
      changedHandlerKeys.clear();
      filesWithChangedHandlers.clear();
      changedStyleKeys.clear();
      this.processedHandlersThisPass = new WeakSet();
      this.processedStylesThisPass = new WeakSet();
    }
    this.passDepth++;
  }

  /**
   * Get the next occurrence index for a name in a file.
   * Each call increments the counter, so call exactly once per ClientTools instance per name.
   */
  getNextOccurrenceIndex(
    sourceFileUrl: string,
    name: string,
    kind: "handler" | "style" | "bundle",
  ): number {
    const key = `${kind}::${sourceFileUrl}::${name}`;
    const index = this.nameOccurrences.get(key) ?? 0;
    this.nameOccurrences.set(key, index + 1);
    return index;
  }

  /** Read a cached handler filename by instantiation index */
  getCachedHandler(
    sourceFileUrl: string,
    fnName: string,
    index: number,
  ): string | undefined {
    return this.files[sourceFileUrl]?.handlers[fnName]?.[index];
  }

  /** Write a cached handler filename at the given instantiation index */
  setCachedHandler(
    sourceFileUrl: string,
    fnName: string,
    index: number,
    filename: string,
  ): void {
    const entry = this.files[sourceFileUrl];
    if (!entry) return;
    entry.handlers[fnName] ??= [];
    entry.handlers[fnName][index] = filename;
    this.markDirty();
  }

  /** Read a cached style filename by instantiation index */
  getCachedStyle(
    sourceFileUrl: string,
    styleName: string,
    index: number,
  ): string | undefined {
    return this.files[sourceFileUrl]?.styles[styleName]?.[index];
  }

  /** Write a cached style filename at the given instantiation index */
  setCachedStyle(
    sourceFileUrl: string,
    styleName: string,
    index: number,
    filename: string,
  ): void {
    const entry = this.files[sourceFileUrl];
    if (!entry) return;
    entry.styles[styleName] ??= [];
    entry.styles[styleName][index] = filename;
    this.markDirty();
  }

  /** Mark the cache as dirty and schedule a flush to disk */
  markDirty(): void {
    if (this.trustCache || memoryBuild) return;
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.dirty || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.dirty) return;
      this._writeSync();
    });
  }

  /** Synchronously persist the current cache state to disk. */
  save(): void {
    this._writeSync();
  }

  private _writeSync(): void {
    if (memoryBuild) return;
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const data: ClientToolsCache = {
        version: 4,
        hashConfig: this.hashConfig,
        files: this.files,
      };
      // Atomic write: write to temp file then rename, so a watcher restart
      // mid-write can't corrupt the cache.
      const tmp = `${CACHE_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, CACHE_PATH);
      this.dirty = false;
    } catch (e) {
      console.warn("[tiny-tools] failed to write cache:", e);
    }
  }

  /** Get the mtime of a source file (memoized) */
  getSourceFileMtimeMs(sourceFileUrl: string): number | null {
    if (memoryBuild) return null;
    if (this.trustCache) {
      return this.files[sourceFileUrl]?.mtimeMs ?? null;
    }
    const memo = this.sourceFileMtimeMemo.get(sourceFileUrl);
    if (memo !== undefined) return memo;
    try {
      // Resolve relative paths (produced by normalizeSourceFileUrl) back to
      // absolute file:// URLs so statSync can find them.
      const url = sourceFileUrl.startsWith("file://")
        ? new URL(sourceFileUrl)
        : new URL(sourceFileUrl, CWD_URL);
      const stat = statSync(url);
      const value = stat.mtime ? stat.mtime.getTime() : null;
      this.sourceFileMtimeMemo.set(sourceFileUrl, value);
      return value;
    } catch {
      this.sourceFileMtimeMemo.set(sourceFileUrl, null);
      return null;
    }
  }

  /**
   * Check whether the source file's mtime differs from the cached mtime.
   *
   * This does NOT persist the new mtime. The cache mtime is only updated
   * via {@link commitSourceMtime} once the dependent build artifact has
   * actually been rewritten, so a crash or early exit mid-rebuild cannot
   * leave the cache claiming the source is up to date while the generated
   * `.js`/`.css` file on disk is still stale.
   */
  checkAndTrackMtimeChange(sourceFileUrl: string): boolean {
    if (this.trustCache) return false;

    // If we already detected a change for this file this run, return true
    if (this.filesWithMtimeChange.has(sourceFileUrl)) {
      return true;
    }

    const sourceMtimeMs = this.getSourceFileMtimeMs(sourceFileUrl);
    if (sourceMtimeMs === null) return false;

    const existingEntry = this.files[sourceFileUrl];
    if (!existingEntry) {
      // New file - create entry (with mtimeMs left at 0 until a rebuild
      // commits the real value) and mark as changed.
      this.files[sourceFileUrl] = emptySourceFileCacheEntry();
      this.markDirty();
      this.filesWithMtimeChange.add(sourceFileUrl);
      return true;
    }

    if (existingEntry.mtimeMs !== sourceMtimeMs) {
      // mtime differs - track the change but leave the persisted mtime
      // untouched until commitSourceMtime() is called post-rebuild.
      this.filesWithMtimeChange.add(sourceFileUrl);
      return true;
    }

    return false;
  }

  /**
   * Persist the current source file mtime to the cache. Call this only
   * after every artifact dependent on the source file has been
   * successfully rewritten (or confirmed up to date on disk) for the
   * current source mtime.
   */
  commitSourceMtime(sourceFileUrl: string): void {
    if (this.trustCache) return;
    const entry = this.files[sourceFileUrl];
    if (!entry) return;
    const sourceMtimeMs = this.getSourceFileMtimeMs(sourceFileUrl);
    if (sourceMtimeMs === null) return;
    if (entry.mtimeMs === sourceMtimeMs) return;
    entry.mtimeMs = sourceMtimeMs;
    this.markDirty();
  }

  /**
   * Commit mtimes for every source file that was detected as changed in
   * the current detection pass and clear the pending set. Safe because
   * `revalidateAndBuild` / `revalidate` eagerly iterate every sibling
   * artifact for a source file as soon as a change is detected, so by
   * the time we reach this call every on-disk artifact for each pending
   * source is guaranteed to be fresh.
   *
   * Refcounted counterpart to {@link beginChangeDetectionPass}: only the
   * final call of a concurrent batch actually persists mtimes so that
   * siblings still running in parallel cannot see a committed mtime
   * mid-pass and incorrectly skip rebuilds.
   */
  commitPendingSourceMtimes(): void {
    if (this.trustCache) return;
    if (this.passDepth > 0) {
      this.passDepth--;
      if (this.passDepth > 0) return;
    }
    for (const sourceFileUrl of this.filesWithMtimeChange) {
      this.commitSourceMtime(sourceFileUrl);
    }
    this.filesWithMtimeChange.clear();
  }

  /** Register a `ScopedStyleImpl` with the source-file sibling index. */
  registerStyleForSource(sourceFileUrl: string, impl: object): void {
    let set = this.stylesBySource.get(sourceFileUrl);
    if (!set) {
      set = new Set();
      this.stylesBySource.set(sourceFileUrl, set);
    }
    set.add(impl);
  }

  /** Every style impl registered against the given source file URL. */
  getStylesForSource(sourceFileUrl: string): ReadonlySet<unknown> {
    return this.stylesBySource.get(sourceFileUrl) ?? EMPTY_SET;
  }

  /** True if the handler impl has already been revalidated this pass. */
  isHandlerProcessedThisPass(impl: object): boolean {
    return this.processedHandlersThisPass.has(impl);
  }

  /** Mark a handler impl as revalidated for the current pass. */
  markHandlerProcessedThisPass(impl: object): void {
    this.processedHandlersThisPass.add(impl);
  }

  /** True if the style impl has already been revalidated this pass. */
  isStyleProcessedThisPass(impl: object): boolean {
    return this.processedStylesThisPass.has(impl);
  }

  /** Mark a style impl as revalidated for the current pass. */
  markStyleProcessedThisPass(impl: object): void {
    this.processedStylesThisPass.add(impl);
  }
}

const EMPTY_SET: ReadonlySet<unknown> = new Set();

/**
 * Directory (relative to the app's CWD) where handler `.js` files are
 * written by the lazy-mode revalidate path. Matches the hardcoded path
 * used by `ClientToolsClass._doEnsureBuilt` — kept in one place so that
 * eager cross-artifact sibling iteration (e.g. a style detecting a source
 * change and forcing its sibling handlers to rewrite) can use the same
 * output directory without duplicating the string.
 */
export const DEFAULT_HANDLER_DIR = "./public/handlers";

/** Directory (relative to the app's CWD) where style bundles are written by the lazy-mode path. */
export const DEFAULT_STYLES_DIR = "./public/styles";

/**
 * Prefixed to the hash behind style bundle filenames; change it when the
 * emitted CSS changes shape, so stale bundles are not reused (v2 states the
 * layer order in every bundle).
 */
const STYLE_BUNDLE_FORMAT = "v2:";

/** Shared cache instance for all client tools */
export const cache = new ClientToolsCacheManager();

export const registeredClientTools: Set<AnyClientToolsInstance> = new Set();

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

/** The empty object type, used where a collection defines no handlers, styles or signals. */
type Empty = Record<never, never>;

// ============================================================================
// Type Definitions
// ============================================================================

/** Collections whose handler slot holds something other than handlers. */
type NotHandlers =
  | { readonly _isSignals: true }
  | { readonly _isTemplates: true };

/** Extract functions type from a ClientTools instance */
type ExtractFunctions<T> = T extends NotHandlers ? Empty
  // deno-lint-ignore no-explicit-any
  : T extends ClientToolsClass<infer F, any, any> ? F
  : Empty;

/** Extract styles type from a ClientTools instance (excludes global styles) */
type ExtractStyles<T> = T extends NotHandlers ? Empty
  // deno-lint-ignore no-explicit-any
  : T extends ClientToolsClass<any, infer S, any> ? S
  : Empty;

type ReservedStyledKey = "mergeClasses" | "run";

type ForbidReservedStyledKeys<T extends Record<string, ScopedStyleInput>> =
  & T
  & {
    [K in Extract<keyof T, ReservedStyledKey>]?: never;
  };

/** Resolved handlers, styles, and the current request context. */
export type ImportedTools<
  TFunctions,
  TStyles,
  TSignals = Empty,
  TConstants = Empty,
  TTemplates = Empty,
  TComponents = Empty,
> = {
  /**
   * The values of every imported `tiny.Constants`, merged. Inside a Handlers
   * or Signals definition, code that ships to the browser reads them as
   * `constants` (named exactly that): the bundle declares a copy.
   */
  readonly constants: TConstants;
  readonly fn: HandlerReferences<TFunctions>;
  readonly signal: SignalReferences<TSignals>;
  /**
   * The clones of every imported `tiny.Templates` collection. In a handler,
   * `template.name()` is a `DocumentFragment` to insert; while rendering it
   * is the same markup as raw HTML, so a page can show the first instance of
   * what handlers add later.
   */
  readonly template: TTemplates;
  /**
   * Every imported `tiny.SignalComponent`, by name, and
   * `component.instance()` to make one linked instance of each.
   */
  readonly component: TComponents & ComponentLinker<TComponents>;
  readonly styled: ActivateScopedStyles<TStyles>;
  readonly c: Context;
};

// deno-lint-ignore no-explicit-any
type AnyClientToolsInstance = ClientToolsClass<any, any, any>;

type ExtractSignals<T> = T extends { readonly _isSignals: true }
  // deno-lint-ignore no-explicit-any
  ? T extends ClientToolsClass<infer Functions, any, any> ? Functions : Empty
  : Empty;

/** The values of a `tiny.Constants` import; nothing for other tools. */
type ExtractConstants<T> = T extends ConstantsClass<infer Values> ? Values
  : Empty;

/** The clones of a `tiny.Templates` import; nothing for other tools. */
type ExtractTemplates<T> = T extends { readonly _isTemplates: true }
  // deno-lint-ignore no-explicit-any
  ? T extends ClientToolsClass<infer Clones, any, any> ? Clones : Empty
  : Empty;

/** Anything `tiny.imports()` accepts. */
type Importable =
  | AnyClientToolsInstance
  | ConstantsClass<SignalConstants>
  | AnySignalComponent;

type HandlerFactory<T extends Record<string, AnyFunction>> = () =>
  | T
  | Promise<T>;

/** What `tiny.imports(...tools)` resolves to. */
type ImportsOf<TTools extends readonly Importable[]> = ImportedTools<
  UnionToIntersection<ExtractFunctions<TTools[number]>>,
  UnionToIntersection<ExtractStyles<TTools[number]>>,
  UnionToIntersection<ExtractSignals<TTools[number]>>,
  UnionToIntersection<ExtractConstants<TTools[number]>>,
  UnionToIntersection<ExtractTemplates<TTools[number]>>,
  UnionToIntersection<ExtractComponents<TTools[number]>>
>;

/** The tools given to `tiny.Handlers(tools, factory)`, as a list. */
type ToolList<TTools> = TTools extends readonly Importable[] ? TTools
  : [TTools];

/** A handler factory given its tools: `({ signal }) => ({ ... })`. */
type ImportingHandlerFactory<
  T extends Record<string, AnyFunction>,
  // deno-lint-ignore no-explicit-any
  Imported = any,
> = (imported: Imported) => T | Promise<T>;

type HandlerDefinitionScope = {
  owner: AnyClientToolsInstance;
  dependencies: Map<string, ClientFunctionImpl>;
  /** Merged `tiny.Constants` values; absent until the definition imports one. */
  constants?: Record<string, SignalConstant>;
  active: boolean;
  /**
   * Set while `owner` renders template markup: `tiny.imports()` behaves as
   * outside a definition, but the owner still counts as the caller for
   * circular definition checks.
   */
  rendering?: boolean;
  /**
   * Each `tiny.imports()` of the definition and what it imported, checked
   * against the shipped source once it is defined. Absent in prod mode.
   */
  imports?: { site: string; collections: ImportedCollection[] }[];
};

const handlerDefinitionScope = new AsyncLocalStorage<HandlerDefinitionScope>();

/**
 * The async context of module load, before any request: templates render in
 * it so a collection first needed during a request still renders as if
 * outside one, recording its assets for itself rather than for that page.
 */
const requestFreeContext = AsyncLocalStorage.snapshot();

// deno-lint-ignore no-explicit-any
type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends
  ((arg: infer I) => void) ? I : never;

// ============================================================================
// Constants
// ============================================================================

/**
 * Plain values for `tiny.imports()`. Code that ships to the browser cannot
 * close over module values, so a Handlers or Signals definition imports them
 * and reads them as `constants`: the bundle declares a JSON copy, and the
 * server uses the same copy, so both sides see identical data.
 */
class ConstantsClass<Values extends SignalConstants> {
  /** A JSON copy of the values passed in. */
  readonly values: Values;

  /**
   * Takes a plain object of JSON values; it keeps a copy, so later changes
   * to the object have no effect.
   */
  constructor(values: Values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new TypeError("tiny.Constants takes a plain object of values.");
    }
    for (const [name, value] of Object.entries(values)) {
      if (JSON.stringify(value) === undefined) {
        throw new TypeError(
          `Constant '${name}' must be a JSON value, not ${typeof value}.`,
        );
      }
    }
    this.values = JSON.parse(JSON.stringify(values));
  }
}

/** Merges `sets` into `target`, rejecting a key that is defined twice. */
function mergeConstants(
  target: Record<string, SignalConstant>,
  sets: readonly ConstantsClass<SignalConstants>[],
): Record<string, SignalConstant> {
  for (const set of sets) {
    for (const [name, value] of Object.entries(set.values)) {
      if (Object.hasOwn(target, name)) {
        throw new Error(`Duplicate imported constant '${name}'.`);
      }
      target[name] = value;
    }
  }
  return target;
}

/** The module-level declaration a bundle needs for `constants`, if any. */
function constantsDeclaration(
  constants: Record<string, SignalConstant> | undefined,
): string {
  return constants ? `const constants = ${JSON.stringify(constants)};\n` : "";
}

// ============================================================================
// ClientTools Factory Class
// ============================================================================

/**
 * Options for creating a ClientTools instance.
 */
export interface ClientToolsOptions<
  TFunctions extends Record<string, AnyFunction> = Empty,
  TStyles extends Record<string, ScopedStyleInput> = Empty,
> {
  /** Client functions to define */
  functions?: TFunctions;
  /** Scoped styles to define */
  styles?: ForbidReservedStyledKeys<TStyles>;
}

/**
 * Constructor interface for ClientTools that enables type inference from options.
 * @internal Used only by Handlers and Styles constructors.
 */
interface ClientToolsConstructor {
  /** Create an empty ClientTools instance */
  new (sourceFileUrl: string | URL): ClientToolsClass<Empty, Empty, Empty>;

  /** Create a ClientTools instance with options - types are inferred from the options */
  new <
    TFunctions extends Record<string, AnyFunction> = Empty,
    TStyles extends Record<string, ScopedStyleInput> = Empty,
  >(
    sourceFileUrl: string | URL,
    options: ClientToolsOptions<TFunctions, TStyles>,
  ): ClientToolsClass<TFunctions, TStyles, Empty>;
}

/**
 * Each collection takes `import.meta.url` as an optional first argument. It
 * only lets `--lazy` builds tie generated files to their source file, so
 * they can remove the ones an edit replaces; without it files are named
 * after the first name defined (`resetType_handler_<hash>`).
 */
interface HandlersConstructor {
  /** An async (or sync) definition that may import other tools. */
  new <TFunctions extends Record<string, AnyFunction>>(
    factory: HandlerFactory<TFunctions>,
  ): ClientToolsClass<TFunctions, Record<never, never>, Record<never, never>>;
  /** Handlers that need nothing from other tools. */
  new <TFunctions extends Record<string, AnyFunction> = Empty>(
    functions: TFunctions,
  ): ClientToolsClass<TFunctions, Empty, Empty>;
  /** As above, with `import.meta.url`. */
  new <TFunctions extends Record<string, AnyFunction>>(
    sourceFileUrl: string | URL,
    factory: HandlerFactory<TFunctions>,
  ): ClientToolsClass<TFunctions, Record<never, never>, Record<never, never>>;
  /** Handlers that need nothing from other tools. */
  new <TFunctions extends Record<string, AnyFunction> = Empty>(
    sourceFileUrl: string | URL,
    functions: TFunctions,
  ): ClientToolsClass<TFunctions, Empty, Empty>;
  /**
   * Handlers given the tools before them, one or an array, imported as
   * `tiny.imports(...tools)` would: `new tiny.Handlers(counter, ({ signal })
   * => ({ add() { signal.count.value++; } }))` or `new tiny.Handlers([base,
   * counter], ({ signal, fn }) => ...)`. Destructure what the handlers use
   * under its own name (`signal`, `fn`, `constants`): those names are what
   * the browser bundle resolves.
   */
  new <
    const TTools extends Importable | readonly [Importable, ...Importable[]],
    TFunctions extends Record<string, AnyFunction>,
  >(
    tools: TTools,
    factory: ImportingHandlerFactory<TFunctions, ImportsOf<ToolList<TTools>>>,
  ): ClientToolsClass<TFunctions, Record<never, never>, Record<never, never>>;
  /** As above, with `import.meta.url`. */
  new <
    const TTools extends Importable | readonly [Importable, ...Importable[]],
    TFunctions extends Record<string, AnyFunction>,
  >(
    sourceFileUrl: string | URL,
    tools: TTools,
    factory: ImportingHandlerFactory<TFunctions, ImportsOf<ToolList<TTools>>>,
  ): ClientToolsClass<TFunctions, Record<never, never>, Record<never, never>>;
}

/** A `tiny.Signals` collection; `Deferred` marks the async definition form. */
type SignalsCollection<
  Definitions extends SignalDefinitions,
  Deferred extends boolean,
> = ClientToolsClass<SignalAccessors<Definitions>, Empty, Empty> & {
  readonly _isSignals: true;
  /**
   * Marks an instance root for this collection's `perInstance` signals:
   * `<fieldset tt-instance={collection.instanceKey}>`. Per-instance signals
   * bound anywhere inside it resolve to that instance. One element can root
   * several collections by listing their keys separated by spaces.
   */
  readonly instanceKey: string;
  /** The root marker for the signals of `perInstance(name, ...)`. */
  instanceKeyFor(name: InstanceLevels<Definitions>): string;
  /**
   * A `tt-seed` value that starts a root's new instance from `values`
   * instead of the factory's initial values, so it begins as the server
   * rendered it:
   * `<fieldset tt-instance={c.instanceKey} tt-seed={c.seed({ shade: "B1" })}>`.
   * Only writable signals of the unnamed `perInstance` are accepted. An
   * instance resumed on the same element keeps its own values. A root has
   * one `tt-seed`, so it can seed one of the collections it roots.
   */
  seed(values: InstanceSeed<Definitions>): string;
  /** As `seed`, for a root of `perInstance(name, ...)`. */
  seedFor<Level extends InstanceLevels<Definitions> & string>(
    name: Level,
    values: InstanceSeed<Definitions, Level>,
  ): string;
  /**
   * Runs the factory on the server with `inputs` written to its writable
   * signals and returns every signal's value, so initial markup can be
   * rendered by the same computations the browser runs. Each call builds a
   * fresh graph; nothing is shared between calls. A collection with an async
   * definition resolves it first, so the result is a promise.
   *
   * Per-instance signals report a fresh instance's values, or with `seed`
   * (the object given to `seed()`) those of an instance started from it, so
   * a seeded root renders its first text from the same computeds.
   */
  evaluateUsingInitialValues(
    inputs?: SignalInputs<Definitions>,
    seed?: InstanceSeed<Definitions>,
  ): Deferred extends true ? Promise<SignalValues<Definitions>>
    : SignalValues<Definitions>;
  /**
   * This collection, for `tiny.imports()`, with the server's initial values
   * evaluated from `inputs` and `seed` as `evaluateUsingInitialValues` does:
   * `tiny.imports(wageSignals.withInputs({ netProduction }))`. The imported
   * signals' `.initial` and live text placed as a child then start from
   * those values. It changes nothing in the browser: a seeded root still
   * needs its `tt-seed`. Anywhere else it is the collection itself.
   */
  withInputs(
    inputs?: SignalInputs<Definitions>,
    seed?: InstanceSeed<Definitions>,
  ): SignalsCollection<Definitions, Deferred>;
};

/**
 * Both overloads take `(tools) => ...` so a factory's parameters get the same
 * contextual type whichever overload TypeScript tries first; an async
 * definition simply ignores the parameter.
 */
/**
 * The type of a signal made from an initial value: a lone literal widens
 * (`Signal<number>`, not `Signal<0>`), a union of literals given with `as`
 * is kept (`"B1" as "B1" | "A1"`).
 */
type WidenedValue<Value, All = Value> = Value extends boolean ? boolean
  : Value extends number ? number
  : Value extends string ? [All] extends [Value] ? string : Value
  : Value;

type ValueSignals<Values extends Record<string, SignalValue>> = {
  [Name in keyof Values]: Signal<WidenedValue<Values[Name]>>;
};

/**
 * What `define` returns in `tiny.Signals(tools, define)`. Its entries are not
 * constrained here, as a narrower constraint stops `this` being inferred in
 * its computeds: `ShapeSignals` types an invalid entry `never`, and the
 * definition rejects it when it runs.
 */
type SignalShape = Record<string, unknown>;

/**
 * Each built signal as it is, each function a computed of its result, each
 * initial value a writable signal.
 */
type ShapeSignals<Shape extends SignalShape> = {
  [Name in keyof Shape]: Shape[Name] extends SignalDefinitions[string]
    ? Shape[Name]
    : Shape[Name] extends () => infer Value ? ReadonlySignal<Value>
    : Shape[Name] extends SignalValue ? Signal<WidenedValue<Shape[Name]>>
    : never;
};

/**
 * The builders `define` receives in `tiny.Signals(tools, define)`, with a
 * `perInstance` whose callback returns a shape, as `define` does.
 */
type ShapeTools = Omit<SignalTools, "perInstance"> & {
  perInstance: {
    /** Signals every instance root gets its own copy of; see `SignalTools`. */
    <Shape extends SignalShape>(
      define: () => Shape & ThisType<ShapeSignals<Shape>>,
    ): InstanceSignals<ShapeSignals<Shape>>;
    /** A named group, required when nested inside another `perInstance`. */
    <const Level extends string, Shape extends SignalShape>(
      name: Level,
      define: () => Shape & ThisType<ShapeSignals<Shape>>,
    ): InstanceSignals<ShapeSignals<Shape>, Level>;
  };
};

/**
 * `define` in `tiny.Signals(tools, define)`: given what `tools` import and
 * the signal builders, and `this` in its computeds is its own signals.
 */
type ShapeDefinition<
  TTools extends Importable | readonly Importable[],
  Shape extends SignalShape,
> = (
  imported: ImportsOf<ToolList<TTools>> & ShapeTools,
) => Shape & ThisType<ShapeSignals<Shape>>;

interface SignalsConstructor {
  /**
   * An async definition that imports handlers and constants, then returns
   * the factory: `async () => { const { fn, constants } = await
   * tiny.imports(helpers, defaults); return ({ Signal }) => ({ ... }); }`.
   * Only the factory ships to the browser, where `fn.helper` becomes an
   * import of that handler and `constants` a copy of the imported values; on
   * the server `fn.helper` calls the handler directly. The factory may
   * reference `fn` and `constants` (named exactly that), nothing else from
   * the definition, so any other capture fails at definition time instead
   * of in the browser.
   */
  new <Definitions extends SignalDefinitions>(
    definition: (
      tools: SignalTools,
    ) => Promise<(tools: SignalTools) => Definitions>,
  ): SignalsCollection<Definitions, true>;
  /** A factory that needs nothing from module scope. */
  new <Definitions extends SignalDefinitions>(
    factory: (tools: SignalTools) => Definitions,
  ): SignalsCollection<Definitions, false>;
  /** As above, with `import.meta.url` (see `HandlersConstructor`). */
  new <Definitions extends SignalDefinitions>(
    sourceFileUrl: string | URL,
    definition: (
      tools: SignalTools,
    ) => Promise<(tools: SignalTools) => Definitions>,
  ): SignalsCollection<Definitions, true>;
  /** A factory that needs nothing from module scope. */
  new <Definitions extends SignalDefinitions>(
    sourceFileUrl: string | URL,
    factory: (tools: SignalTools) => Definitions,
  ): SignalsCollection<Definitions, false>;
  /**
   * One writable signal per initial value: `new tiny.Signals({ count: 0 })`.
   * Use a factory for `Computed`, `Trigger` or `perInstance`.
   */
  new <Values extends Record<string, SignalValue>>(
    values: Values,
  ): SignalsCollection<ValueSignals<Values>, false>;
  /** As above, with `import.meta.url`. */
  new <Values extends Record<string, SignalValue>>(
    sourceFileUrl: string | URL,
    values: Values,
  ): SignalsCollection<ValueSignals<Values>, false>;
  /**
   * Signals reading the tools before them, one or an array, imported as
   * `tiny.imports(...tools)` would: `new tiny.Signals(counter, ({ signal })
   * => ({ isEven: () => signal.count.value % 2 === 0 }))`. Each function
   * returned becomes a `Computed`, each initial value a writable signal, and
   * a signal already built is kept, so `define` may also take `Signal`,
   * `Computed`, `Trigger`, `perInstance` and `signalsFrom` and return
   * `{ ...perInstance(() => ({ ... })) }`. A computed written as a method
   * reads the collection's own signals as `this`:
   * `{ areas: [], summary() { return this.areas.value.join(", "); } }`.
   * As in a handler, destructure `signal`, `fn` and `constants` by those
   * names. Per-instance signals of another collection cannot be read.
   */
  new <
    const TTools extends Importable | readonly [Importable, ...Importable[]],
    Shape extends SignalShape,
  >(
    tools: TTools,
    define: ShapeDefinition<TTools, Shape>,
  ): SignalsCollection<ShapeSignals<Shape>, true>;
  /** As above, with `import.meta.url`. */
  new <
    const TTools extends Importable | readonly [Importable, ...Importable[]],
    Shape extends SignalShape,
  >(
    sourceFileUrl: string | URL,
    tools: TTools,
    define: ShapeDefinition<TTools, Shape>,
  ): SignalsCollection<ShapeSignals<Shape>, true>;
}

interface StylesConstructor {
  // Overloads without sourceFileUrl (styles as first arg)
  new <
    TStyles extends Record<string, ScopedStyleInput> = Empty,
  >(
    styles: ForbidReservedStyledKeys<TStyles>,
  ): ClientToolsClass<Empty, TStyles, Empty>;

  // Overloads with sourceFileUrl
  new <
    TStyles extends Record<string, ScopedStyleInput> = Empty,
  >(
    sourceFileUrl: string | URL | undefined,
    styles: ForbidReservedStyledKeys<TStyles>,
  ): ClientToolsClass<Empty, TStyles, Empty>;
}

/**
 * Unified factory for creating both client functions and scoped styles.
 * Use `new tiny.Handlers(url, fns)` for event handlers and
 * `new tiny.Styles(url, styles)` for scoped CSS.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { tiny, css } from "@tinytools/hono-tools";
 *
 * const buttonStyle = css`
 *   background: blue;
 *   color: white;
 * `;
 *
 * const routeHandlers = new tiny.Handlers({
 *   handleClick(e: MouseEvent) {
 *     console.log("Clicked", e);
 *   },
 * });
 *
 * const routeStyles = new tiny.Styles({ buttonStyle });
 *
 * // Create app with middleware
 * const app = new Hono()
 *   .use(...tiny.middleware.core());
 *
 * // In route handlers
 * app.get("/", async (c) => {
 *   const { fn, styled } = await tiny.imports(routeHandlers, routeStyles);
 *   return c.render(
 *     <button class={styled.buttonStyle} onClick={fn.handleClick}>
 *       Click me
 *     </button>
 *   );
 * });
 * ```
 */
class ClientToolsClass<
  AccumulatedFunctions = Empty,
  AccumulatedStyles = Empty,
  AccumulatedGlobalStyles = Empty,
> {
  private static readonly RESERVED_FUNCTION_KEYS = new Set<string>(["run"]);
  private static readonly RESERVED_STYLED_KEYS = new Set<string>([
    "mergeClasses",
    "run",
  ]);

  protected sourceFileUrl: string;
  /** Maps fnName -> filename for all handlers added via defineFunction() or import() */
  private handlerFilenames = new Map<string, string>();
  /** Stores ClientFunctionImpl instances for all handlers in this factory */
  private _clientFunctions = new Map<string, ClientFunctionImpl>();
  /** Maps styleName -> filename for all styles added via defineStyles() */
  private styleFilenames = new Map<string, string>();
  /** Stores ScopedStyleImpl instances for all styles in this factory */
  private _scopedStyles = new Map<string, ScopedStyleImpl>();
  /** The style names this instance defines. */
  private _ownStyleNames = new Set<string>();
  /** Previous bundle filename derived from cached constituent style hashes. */
  private _staleOwnBundleFilename?: string;
  /** Whether the on-disk reconciliation prune has run yet for this instance. */
  private _stalePruneDone = false;
  /** Whether ensureBuilt() has already run */
  private _ensureBuiltPromise: Promise<void> | null = null;
  private _definitionReady = true;
  private _definitionPromise: Promise<void> | undefined;
  private _definitionInitializer?: (
    scope: HandlerDefinitionScope,
  ) => Promise<void>;
  private _definitionWaits = new Set<AnyClientToolsInstance>();
  /** The browser module holding this instance's own handlers. */
  private _bundle?: HandlerBundle;
  /** Construction order within the source file; keys the bundle's cache entry. */
  protected _bundleIndex: number;

  /** Stateful bundles (Signals) are unique per instance even when sources match. */
  protected get stateful(): boolean {
    return false;
  }

  /** What this instance's bundle holds, naming it when it has no source file. */
  protected get bundleKind(): "handler" | "signal" | "template" {
    return "handler";
  }

  /** Declares the `constants` a factory definition imported. */
  private _constantsPrelude = "";

  /** Module-level code emitted ahead of this instance's handlers. */
  protected get bundlePrelude(): string {
    return this._constantsPrelude;
  }

  /** Stylesheets the markup this instance's bundle carries needs. */
  protected get bundleStyleFiles(): Iterable<string> {
    return [];
  }

  /** Runtime modules (`tt-*.js`) the bundle's prelude imports. */
  protected get bundleRuntimeFiles(): Iterable<string> {
    return [];
  }

  private _waitsFor(
    target: AnyClientToolsInstance,
    seen = new Set<AnyClientToolsInstance>(),
  ): boolean {
    if (this === target) return true;
    if (seen.has(this)) return false;
    seen.add(this);
    return [...this._definitionWaits].some((dependency) =>
      dependency._waitsFor(target, seen)
    );
  }

  async ensureDefined(): Promise<void> {
    if (this._definitionReady) return;
    const context = handlerDefinitionScope.getStore();
    const caller = context && (context.active || context.rendering)
      ? context.owner
      : undefined;
    if (caller && this._waitsFor(caller)) {
      throw new Error(
        `Circular handler definition dependency: ${caller.sourceFileUrl} -> ${this.sourceFileUrl}`,
      );
    }
    caller?._definitionWaits.add(this);
    try {
      this._definitionPromise ??= Promise.resolve().then(() =>
        handlerDefinitionScope.run({
          owner: this,
          dependencies: new Map(),
          active: true,
        }, async () => {
          const scope = handlerDefinitionScope.getStore()!;
          try {
            await this._definitionInitializer!(scope);
            this._definitionReady = true;
          } finally {
            scope.active = false;
          }
        })
      );
      await this._definitionPromise;
    } finally {
      caller?._definitionWaits.delete(this);
    }
  }

  protected defineFactory(
    factory: HandlerFactory<Record<string, AnyFunction>>,
  ): void {
    this.defineDeferred(async (scope) => {
      const functions = await factory();
      if (
        !functions || typeof functions !== "object" ||
        Object.values(functions).some((value) => typeof value !== "function")
      ) {
        throw new TypeError(
          "Handlers factory must return an object of handler functions.",
        );
      }
      if (scope.imports) {
        checkDefinitionImports(
          scope.imports,
          Object.values(functions).map(String).join("\n"),
        );
      }
      this._constantsPrelude = constantsDeclaration(scope.constants);
      this._processFunctions(functions, scope.dependencies);
      await this._bundle?.pruneDependencies();
      this._refreshHandlerFilenames();
    });
  }

  /** Defers this instance's handlers to `initializer`, run by `ensureDefined`. */
  protected defineDeferred(
    initializer: (scope: HandlerDefinitionScope) => Promise<void>,
  ): void {
    this._definitionReady = false;
    this._definitionInitializer = initializer;
  }

  private _refreshHandlerFilenames(): void {
    for (const [name, instance] of this._clientFunctions) {
      this.handlerFilenames.set(name, instance.filename);
    }
  }

  constructor(
    sourceFileUrl: string | URL | undefined,
    // deno-lint-ignore no-explicit-any
    options?: ClientToolsOptions<any, any>,
  ) {
    this.sourceFileUrl = normalizeSourceFileUrl(sourceFileUrl) ??
      (typeof sourceFileUrl === "string"
        ? sourceFileUrl
        : sourceFileUrl?.toString() ?? "");
    this._bundleIndex = cache.getNextOccurrenceIndex(
      this.sourceFileUrl,
      "",
      "bundle",
    );
    registeredClientTools.add(this);
    if (options?.functions) this._processFunctions(options.functions);
    if (options?.styles) this._processStyles(options.styles);
    // After all styles are processed, bundle scoped styles into one file
    this._finalizeStyleBundle();
  }

  /** Internal helper to process function definitions */
  protected _processFunctions<T extends Record<string, AnyFunction>>(
    fns: T,
    dependencies?: ReadonlyMap<string, ClientFunctionImpl>,
  ): void {
    const registry = getImportRegistry(this.sourceFileUrl);
    for (const [fnName, fn] of Object.entries(fns)) {
      if (ClientToolsClass.RESERVED_FUNCTION_KEYS.has(fnName)) {
        throw new Error(
          `Cannot define function '${fnName}': this key is reserved by fn API.`,
        );
      }

      this._bundle ??= new HandlerBundle({
        sourceFileUrl: this.sourceFileUrl,
        index: this._bundleIndex,
        stateful: this.stateful,
        kind: this.bundleKind,
        dependencies,
        prelude: this.bundlePrelude,
        styleFiles: this.bundleStyleFiles,
        runtimeFiles: this.bundleRuntimeFiles,
      });
      const instance = this._bundle.add(fnName, fn);
      registry.set(fnName, instance);
      this._clientFunctions.set(fnName, instance);
    }
    this._refreshHandlerFilenames();
  }

  /**
   * The style bundle's filename prefix: the source file's name, or without
   * one the first style's (`button_style`).
   */
  private get styleBundleBase(): string {
    const urlPath = this.sourceFileUrl.replace(/\\/g, "/");
    return urlPath.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      unsourcedFilenameBase([...this._ownStyleNames][0], "style");
  }

  /**
   * After all own scoped styles are collected, compute a bundle filename
   * from the sorted individual filenames and register the bundle.
   */
  private _finalizeStyleBundle(): void {
    if (this._ownStyleNames.size === 0) return;

    const ownStyles = [...this._scopedStyles.entries()]
      .filter(([name]) => this._ownStyleNames.has(name));

    if (ownStyles.length === 0) return;

    const sortedStyleHashes = ownStyles
      .map(([, s]) => getFilenameHashFragment(s.filename))
      .sort();
    const sortedCleanupStyleHashes = ownStyles
      .map(([, s]) => getFilenameHashFragment(s.cleanupFilenameForCurrentBuild))
      .sort();

    const baseName = this.styleBundleBase;
    const bundleFilename = `${baseName}_${
      generateStyleHash(STYLE_BUNDLE_FORMAT + sortedStyleHashes.join(","))
    }`;
    const staleBundleFilename = `${baseName}_${
      generateStyleHash(
        STYLE_BUNDLE_FORMAT + sortedCleanupStyleHashes.join(","),
      )
    }`;
    this._staleOwnBundleFilename = staleBundleFilename !== bundleFilename
      ? staleBundleFilename
      : undefined;

    // Register the bundle
    styleBundleRegistry.set(bundleFilename, ownStyles.map(([, s]) => s));

    // Update only own scoped style entries to point to the bundle filename
    for (const styleName of this._ownStyleNames) {
      this.styleFilenames.set(styleName, bundleFilename);
    }
  }

  /**
   * Recompute the bundle filename after any constituent style filename
   * changes.
   * @internal
   */
  refreshStyleAssetMappings(): {
    oldBundleFilename?: string;
    newBundleFilename?: string;
  } {
    const firstOwnStyleName = this._ownStyleNames.values().next().value as
      | string
      | undefined;
    const oldBundleFilename = firstOwnStyleName
      ? this.styleFilenames.get(firstOwnStyleName)
      : undefined;

    if (this._ownStyleNames.size > 0) {
      this._finalizeStyleBundle();
    }

    const newBundleFilename = firstOwnStyleName
      ? this.styleFilenames.get(firstOwnStyleName)
      : undefined;

    return { oldBundleFilename, newBundleFilename };
  }

  /**
   * Deferred validation and build for all handlers and styles in this instance.
   * Called by tiny.imports(). Skips entirely in prod mode.
   * Subsequent calls return the same promise (idempotent).
   */
  async ensureBuilt(): Promise<void> {
    await this.ensureDefined();
    this._refreshHandlerFilenames();
    if (cache.trustCache) return;
    if (this._ensureBuiltPromise) return this._ensureBuiltPromise;
    const buildPromise = this._doEnsureBuilt();
    this._ensureBuiltPromise = buildPromise;
    try {
      await buildPromise;
    } finally {
      if (this._ensureBuiltPromise === buildPromise) {
        this._ensureBuiltPromise = null;
      }
    }
  }

  private async _doEnsureBuilt(): Promise<void> {
    const handlerDir = DEFAULT_HANDLER_DIR;
    const stylesDir = DEFAULT_STYLES_DIR;

    cache.beginChangeDetectionPass();

    // Write every bundle these handlers live in, along with everything those
    // bundles import.
    const bundles = new Set(
      [...this._clientFunctions.values()].map((impl) => impl.bundle),
    );
    for (const bundle of bundles) {
      await bundle.ensureWritten(handlerDir);
    }
    this._refreshHandlerFilenames();

    // Capture old filenames before revalidation so we can clean up stale
    // files AND so we can detect filename shifts that happened indirectly
    // via sibling fanout (where the outer revalidate() call returns false
    // because the style/handler was already processed earlier in the pass
    // as a sibling of another artifact sharing the same source file).
    const oldScopedStyleFilenames = new Map<string, string>();
    for (const [name, impl] of this._scopedStyles) {
      oldScopedStyleFilenames.set(name, impl.filename);
    }

    // Revalidate all scoped styles
    let anyStyleChanged = false;
    for (const [, impl] of this._scopedStyles) {
      const changed = await impl.revalidate();
      if (changed) {
        anyStyleChanged = true;
      }
    }

    // Detect filename changes that occurred via sibling fanout. A style
    // revalidated as a sibling of another artifact (e.g. when foo's
    // revalidate fans out to bar in the same source file) will have its
    // `filename` mutated, but the outer revalidate() call for that style
    // returns false because it sees the style is already processed for
    // this pass. Without this check, anyStyleChanged would stay false and
    // the bundle filename — recomputed from per-style filename fragments —
    // would never refresh, producing stale (non-unique) bundle names.
    if (!anyStyleChanged) {
      for (const [name, oldFilename] of oldScopedStyleFilenames) {
        const impl = this._scopedStyles.get(name);
        if (impl && impl.filename !== oldFilename) {
          anyStyleChanged = true;
          break;
        }
      }
    }

    // A sibling in another instance (such as a handler bundle from the same
    // source) can rename an own style in an earlier pass, before this
    // instance builds. Its bundle is then still the one built for the old
    // name, which the style keeps until the bundle is rebuilt.
    if (!anyStyleChanged) {
      anyStyleChanged = [...this._ownStyleNames].some((name) =>
        this._scopedStyles.get(name)?.staleFilenameForCleanup !== undefined
      );
    }

    // If any own style changed, re-finalize the bundle
    if (anyStyleChanged && this._ownStyleNames.size > 0) {
      const { oldBundleFilename, newBundleFilename } = this
        .refreshStyleAssetMappings();

      if (
        oldBundleFilename && newBundleFilename &&
        oldBundleFilename !== newBundleFilename
      ) {
        styleBundleRegistry.delete(oldBundleFilename);
        if (!memoryBuild) {
          await rm(`${stylesDir}/${oldBundleFilename}.css`).catch(
            () => {},
          );
        }
      }
    }

    // Build style bundle CSS files
    if (this._ownStyleNames.size > 0) {
      const ownStyles = [...this._scopedStyles.entries()]
        .filter(([name]) => this._ownStyleNames.has(name));
      if (ownStyles.length > 0) {
        const bundleFilename = this.styleFilenames.get(
          ownStyles[0][0],
        );
        if (bundleFilename) {
          await this._ensureStyleBundleBuilt(
            stylesDir,
            bundleFilename,
            ownStyles.map(([, s]) => s),
          );
        }

        if (
          this._staleOwnBundleFilename &&
          this._staleOwnBundleFilename !== bundleFilename
        ) {
          if (!memoryBuild) {
            await rm(`${stylesDir}/${this._staleOwnBundleFilename}.css`)
              .catch(() => {});
          }
          this._staleOwnBundleFilename = undefined;
        }

        if (bundleFilename && !this._stalePruneDone) {
          await this._pruneStaleOwnBundleFiles(stylesDir, bundleFilename);
          this._stalePruneDone = true;
        }

        for (const [, style] of ownStyles) {
          style.markCurrentFilenameAsClean();
        }
      }
    }

    // Every artifact for each source file whose mtime changed has been
    // eagerly revalidated inside `revalidateAndBuild` / `revalidate`
    // (including siblings that live in other `ClientTools` instances),
    // so it is now safe to persist their source mtimes.
    cache.commitPendingSourceMtimes();
  }

  private async _ensureStyleBundleBuilt(
    stylesDir: string,
    bundleFilename: string,
    styles: ScopedStyleImpl[],
  ): Promise<void> {
    if (memoryBuild) {
      const assetPath = `/styles/${bundleFilename}.css`;
      if (!memoryAssets.has(assetPath)) {
        const { buildLayeredCssContent } = await import("./build.ts");
        memoryAssets.set(assetPath, buildLayeredCssContent(styles));
      }
      return;
    }
    const filePath = `${stylesDir}/${bundleFilename}.css`;
    const fileExists = await fsStat(filePath).then(() => true).catch(
      () => false,
    );

    const anyChanged = styles.some((style) => {
      const styleKey = style.sourceFileUrl
        ? `${style.sourceFileUrl}::${style.styleName}`
        : "";
      return styleKey && changedStyleKeys.has(styleKey);
    });

    if (fileExists && !anyChanged) return;

    const { buildLayeredCssContent } = await import("./build.ts");
    await mkdir(stylesDir, { recursive: true });
    const cssContent = buildLayeredCssContent(styles);
    await writeFile(filePath, cssContent);
    console.log(
      `Style bundle written: ${filePath} (${styles.length} styles)`,
    );
  }

  /**
   * Reconcile the styles directory against this instance's current bundle
   * filename. Deletes any `${baseName}_*.css` files that don't match the
   * current bundle. Catches stale bundles left behind by interrupted dev
   * runs, hash-config changes, or any earlier edit whose cleanup did not
   * complete. Runs once per instance per process.
   */
  private async _pruneStaleOwnBundleFiles(
    stylesDir: string,
    currentBundleFilename: string,
  ): Promise<void> {
    if (memoryBuild) return;
    if (this._ownStyleNames.size === 0) return;
    const prefix = `${this.styleBundleBase}_`;
    let entries: string[];
    try {
      entries = await readdir(stylesDir);
    } catch {
      return;
    }
    const currentFile = `${currentBundleFilename}.css`;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(prefix) || !entry.endsWith(".css")) return;
        if (entry === currentFile) return;
        // Skip if another registered bundle owns this filename (e.g. an
        // imported instance whose source happens to share the same baseName).
        const withoutExt = entry.slice(0, -".css".length);
        if (styleBundleRegistry.has(withoutExt)) return;
        await rm(`${stylesDir}/${entry}`).catch(() => {});
        console.log(`Pruned stale style bundle: ${stylesDir}/${entry}`);
      }),
    );
  }

  /** Internal helper to process style definitions */
  private _processStyles<T extends Record<string, ScopedStyleInput | string>>(
    styles: T,
  ): void {
    for (const [styleName, styleInput] of Object.entries(styles)) {
      if (ClientToolsClass.RESERVED_STYLED_KEYS.has(styleName)) {
        throw new Error(
          `Cannot define style '${styleName}': this key is reserved by styled API.`,
        );
      }

      const { cssContent, scope, contentMode, layer } =
        normalizeScopedStyleInput(
          styleInput,
        );
      const normalizedCss = normalizeCssWhitespace(cssContent);

      const instance = new ScopedStyleImpl(
        styleName,
        normalizedCss,
        this.sourceFileUrl,
        scope,
        layer,
        contentMode,
      );

      (this as Record<string, unknown>)[styleName] = instance;
      this.styleFilenames.set(styleName, instance.filename);
      this._scopedStyles.set(styleName, instance);
      this._ownStyleNames.add(styleName);
    }
  }

  /**
   * Get the handler filenames map (for internal use by middleware).
   * @internal
   */
  get _handlerFilenames(): ReadonlyMap<string, string> {
    this._refreshHandlerFilenames();
    return this.handlerFilenames;
  }

  get _handlerDefinitions(): ReadonlyMap<string, ClientFunctionImpl> {
    return this._clientFunctions;
  }

  /**
   * Get the style filenames map (for internal use by middleware).
   * @internal
   */
  get _styleFilenames(): ReadonlyMap<string, string> {
    return this.styleFilenames;
  }

  /**
   * Get the scoped styles map (for internal use by middleware).
   * @internal
   */
  get _styles(): ReadonlyMap<string, ScopedStyleImpl> {
    return this._scopedStyles;
  }

  get run(): AccumulatedFunctions {
    if (!this._definitionReady) {
      throw new Error(
        "Handler definitions are not ready. Await tools.ensureDefined() before accessing tools.run.",
      );
    }
    return Object.fromEntries(
      [...this._clientFunctions].map(([name, instance]) => [name, instance.fn]),
    ) as AccumulatedFunctions;
  }

  /**
   * Get generated scoped style class names without requiring request context.
   * Useful for attributes like data-scope-boundary where only class strings are needed.
   */
  get generatedStyleNames(): ReadonlyMap<
    Extract<keyof AccumulatedStyles, string>,
    string
  > {
    const result = new Map<Extract<keyof AccumulatedStyles, string>, string>();
    for (const styleName of this._scopedStyles.keys()) {
      const styleImpl = this._scopedStyles.get(styleName)!;
      result.set(
        styleName as Extract<keyof AccumulatedStyles, string>,
        styleImpl.filename,
      );
    }
    return result;
  }
}

/**
 * @internal Base class constructor — use `Handlers` or `Styles` instead.
 */
export const ClientTools: ClientToolsConstructor =
  ClientToolsClass as ClientToolsConstructor;

class HandlersClass extends ClientToolsClass<Empty, Empty, Empty> {
  /**
   * `(functions)` or `(import.meta.url, functions)`; either may be a factory.
   * Tools between them, one or an array (`(import.meta.url, [a, b],
   * factory)`), are imported for the factory and passed to it, as
   * `tiny.imports(a, b)` would.
   */
  constructor(...args: unknown[]) {
    const sourced = args.length > 1 &&
      (args[0] === undefined || typeof args[0] === "string" ||
        args[0] instanceof URL);
    const sourceFileUrl = sourced ? args[0] as string | URL : undefined;
    const rest = sourced ? args.slice(1) : args;
    if (rest.length > 2) {
      throw new TypeError(
        "tiny.Handlers takes its tools as one argument: an array for several, ([a, b], factory).",
      );
    }
    const tools = (rest.length > 1 ? [rest[0]].flat() : []) as Importable[];
    let functions = rest.at(-1) as
      | Record<string, AnyFunction>
      | HandlerFactory<Record<string, AnyFunction>>
      | ImportingHandlerFactory<Record<string, AnyFunction>>;
    noteUnsourced("Handlers", sourceFileUrl);
    if (rest.length > 1) {
      if (typeof functions !== "function") {
        throw new TypeError(
          "tiny.Handlers(tools, factory) needs a factory: ({ signal }) => ({ ... }).",
        );
      }
      // Taken now, while the definition's own line is on the stack.
      const site = cache.trustCache ? undefined : importCallSite();
      const define = functions as ImportingHandlerFactory<
        Record<string, AnyFunction>
      >;
      functions = async () => define(await importsAt(site, tools));
    }
    if (typeof functions === "function") {
      super(sourceFileUrl);
      this.defineFactory(
        functions as HandlerFactory<Record<string, AnyFunction>>,
      );
      return;
    }
    super(sourceFileUrl, { functions });
  }
}

// ============================================================================
// Lifecycle elements
// ============================================================================

/**
 * Module-level code defining `tags` through the lifecycle runtime, for a
 * template bundle whose markup holds upgraded elements: a clone may land on
 * a page that never declared them, and so may not have the runtime yet, in
 * which case the bundle imports it first. Skipped where no document exists.
 */
function lifecycleDefinitionsPrelude(tags: Iterable<string>): string {
  const unique = [...new Set(tags)];
  if (!unique.length) return "";
  return `if (typeof document !== "undefined") {
  if (!tiny.defineLifecycleElement) {
    // Not a literal, so the bundler leaves the import to the browser.
    const __tiny_lifecycle_runtime = ${JSON.stringify(lifecycleRuntimePath)};
    await import(__tiny_lifecycle_runtime);
  }
${
    unique.map((tag) =>
      `  tiny.defineLifecycleElement(${JSON.stringify(tag)});`
    ).join("\n")
  }
}`;
}

type SignalFactory = (tools: SignalTools) => SignalDefinitions;

/** The async form: imports handlers, then resolves to the factory. */
type SignalDefinition = () => Promise<SignalFactory>;

const AsyncFunction = (async () => {}).constructor;

/**
 * Builds a handler from source text. Handlers ship to the browser as source,
 * so per-instance values (like a signal name) must be spliced in rather than
 * captured by a closure. Free variables resolve in the emitted bundle module.
 */
function handlerFromSource(source: string): AnyFunction {
  return new Function(`return ${source}`)() as AnyFunction;
}

/**
 * Split a factory with one simple parameter, like `({ Signal }) => {...}` or
 * `function (tools) {...}`, into that parameter and the same function with an
 * empty parameter list. Returns undefined for any other shape (several
 * parameters, defaults, rest parameters, async functions).
 */
function splitFactory(
  source: string,
): { parameter: string; body: string } | undefined {
  const trimmed = source.trim();
  const bare = /^([$A-Z_a-z][$\w]*)\s*=>/.exec(trimmed);
  if (bare) {
    return {
      parameter: bare[1],
      body: `() =>${trimmed.slice(bare[0].length)}`,
    };
  }
  const header = trimmed.startsWith("(")
    ? "("
    : /^function\b[^(]*\(/.exec(trimmed)?.[0];
  if (!header) return undefined;
  const open = header.length - 1;
  let depth = 0;
  for (let index = open; index < trimmed.length; index++) {
    const char = trimmed[index];
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (depth === 1 && (char === "," || char === "=" || char === ".")) {
      return undefined;
    } else if ("'\"`/".includes(char)) return undefined;
    if (depth === 0) {
      return {
        parameter: trimmed.slice(open + 1, index).trim(),
        body: `${trimmed.slice(0, open)}()${trimmed.slice(index + 1)}`,
      };
    }
  }
  return undefined;
}

/** Module-level names every Signals bundle may use. */
const SIGNAL_BUNDLE_RESERVED = ["fn", "signal", "stored", "constants"];

/**
 * Rebuilds the factory from its source with only what the browser bundle
 * declares in scope: `fn` and `constants` when the definition imported them.
 * A module-scope capture is then a ReferenceError here instead of a bundle
 * that fails to load in the browser.
 */
function compileSignalFactory(
  factory: SignalFactory,
  scope: {
    references?: Record<string, AnyFunction>;
    constants?: Record<string, SignalConstant>;
    /** Other collections' signals, for a definition that imports them. */
    signal?: object;
  } = {},
): SignalFactory {
  const names: string[] = [];
  const values: unknown[] = [];
  if (scope.signal) {
    names.push("signal");
    values.push(scope.signal);
  }
  if (scope.references) {
    names.push("fn");
    values.push(scope.references);
  }
  if (scope.constants) {
    names.push("constants");
    values.push(JSON.parse(JSON.stringify(scope.constants)));
  }
  try {
    return new Function(...names, `"use strict";\nreturn (${factory});`)(
      ...values,
    ) as SignalFactory;
  } catch (error) {
    throw new TypeError(
      `Signals factory must be an arrow function or function expression: ${
        (error as Error).message
      }`,
    );
  }
}

/**
 * The factory for `new tiny.Signals({ count: 0 })`: one writable signal per
 * value, built by `signalsFrom` from the values inlined as JSON.
 */
function valuesFactory(values: Record<string, SignalValue>): SignalFactory {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError(
      "tiny.Signals takes a factory or an object of initial values.",
    );
  }
  for (const [name, value] of Object.entries(values)) {
    const valid = value === null || typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"));
    if (!valid) {
      throw new TypeError(
        `Signal '${name}' needs a string, finite number, boolean, null or string array; use the factory form for anything else.`,
      );
    }
  }
  return new Function(
    `return ({ signalsFrom }) => signalsFrom(${JSON.stringify(values)});`,
  )() as SignalFactory;
}

/** The builders a `tiny.Signals(tools, define)` definition may take. */
const SHAPE_BUILDERS = ["Trigger", "perInstance", "signalsFrom"];

/**
 * The factory for `new tiny.Signals(tools, ({ signal }) => ({ ... }))`: the
 * definition's source called with what it imports and the signal builders,
 * each function it returns becoming a `Computed` (`this` is the collection's
 * own signals) and each initial value a writable `Signal`; anything already
 * built (a `Signal`, `Computed`, `Trigger` or `perInstance` result) is kept.
 * The `perInstance` it receives builds each instance's shape the same way.
 * Its source is what ships, so `signal`, `fn` and `constants` resolve as in
 * a handler, and only the builders it names are imported in the browser.
 */
function importedShapeFactory(
  define: AnyFunction,
  imported: ReadonlySet<string>,
): SignalFactory {
  const source = define.toString();
  const builders = SHAPE_BUILDERS.filter((name) =>
    new RegExp(`\\b${name}\\b`).test(source)
  );
  const tools = ["Signal", "Computed", "shapeSignals", ...builders];
  const given = [...imported, "Signal", "Computed", ...builders].map((name) =>
    // Each instance's shape is built as the collection's is.
    name === "perInstance" ? "perInstance: shapedPerInstance" : name
  );
  try {
    return new Function(`return ({ ${tools.join(", ")} }) => {
  ${
      builders.includes("perInstance")
        ? `const shapedPerInstance = (...args) => {
    const define = args.pop();
    return perInstance(...args, () => shapeSignals(define(), Signal, Computed));
  };`
        : ""
    }
  return shapeSignals((${source})({ ${given.join(", ")} }), Signal, Computed);
};`)() as SignalFactory;
  } catch (error) {
    throw new TypeError(
      `tiny.Signals(tools, define) needs define to be an arrow function or function expression: ${
        (error as Error).message
      }`,
    );
  }
}

/** Calls a compiled factory, explaining a module-scope capture. */
function runSignalFactory(
  factory: SignalFactory,
  tools: SignalTools,
): SignalDefinitions {
  try {
    const definitions = factory(tools);
    // Signals are EventTargets; per-instance handles name theirs per group.
    for (const [name, signal] of Object.entries(definitions ?? {})) {
      if (signal instanceof EventTarget) signal.name ??= name;
    }
    return definitions;
  } catch (error) {
    const name = error instanceof ReferenceError &&
      /^(.+) is not defined$/.exec(error.message)?.[1];
    if (!name) throw error;
    if (name === "fn" || name === "constants") {
      throw new TypeError(
        `Signals factory references '${name}', which only an async definition that imports it provides: ` +
          "new tiny.Signals(async () => { const { fn, constants } = await tiny.imports(helpers, values); return ({ Signal }) => ({ ... }); }).",
      );
    }
    throw new TypeError(
      `Signals factory references '${name}', which does not exist in the browser bundle. ` +
        "Import module-scope values as constants: const { constants } = await tiny.imports(new tiny.Constants({ ... })).",
    );
  }
}

/**
 * Runs the factory server-side (values inert) to validate it and list its
 * signals, each with the actions its kind offers.
 */
function signalNames(factory: SignalFactory): Map<string, SignalAction[]> {
  const tools = signalClasses(false);
  const definitions = runSignalFactory(factory, tools);
  if (
    !definitions || typeof definitions !== "object" ||
    definitions instanceof Promise ||
    Object.values(definitions).some((value) =>
      !(value instanceof tools.Signal) &&
      !(value instanceof tools.InstanceSignal)
    )
  ) {
    throw new TypeError(
      "Signals factory must synchronously return an object of Signal or Computed instances, or perInstance signals.",
    );
  }
  return new Map(
    Object.entries(definitions).map((
      [name, signal],
    ) => [name, signalActions(signal)]),
  );
}

/**
 * The `fn` an async definition's factory sees on the server: each imported
 * handler called directly. Signals of other collections are read through
 * `signal` only in the `(tools, define)` form, which builds their graphs on
 * the server (`signalsProvided`); an async definition cannot import them.
 */
function serverReferences(
  dependencies: ReadonlyMap<string, ClientFunctionImpl>,
  signalsProvided = false,
): Record<string, AnyFunction> {
  const references: Record<string, AnyFunction> = Object.create(null);
  for (const [key, instance] of dependencies) {
    if (key.startsWith("signal:")) {
      // Read through `signal`, from the graphs `SignalUpstream` builds.
      if (signalsProvided) continue;
      throw new TypeError(
        `A Signals definition can import handlers only; '${
          key.slice(7)
        }' is a signal of another collection.`,
      );
    }
    references[key] = function (this: unknown, ...args: unknown[]) {
      return Reflect.apply(instance.fn, this, args);
    };
  }
  return references;
}

/**
 * One bundle per instance: the prelude declares the constants, runs the
 * factory once against the shared signal runtime (signals.ts), and each
 * signal is exported as an accessor that can be referenced like any handler.
 */
/**
 * Turns `(tools, define)` into an async definition: it imports `tools` and
 * returns `define` as a factory (see `importedShapeFactory`), recording the
 * signals collections among them in `upstream`.
 */
function importingDefinition(
  [tools, define]: unknown[],
  upstream: SignalUpstream,
): SignalDefinition {
  if (typeof define !== "function" || define instanceof AsyncFunction) {
    throw new TypeError(
      "tiny.Signals(tools, define) needs a synchronous define: ({ signal }) => ({ total: () => ... }).",
    );
  }
  const list = [tools].flat() as Importable[];
  const imported = new Set<string>();
  for (const tool of list) {
    const collection = signalInputs.get(tool as AnyClientToolsInstance)
      ?.collection ?? tool;
    if (collection instanceof SignalsClass) {
      upstream.collections.push(collection);
      imported.add("signal");
    } else if (collection instanceof ConstantsClass) {
      imported.add("constants");
    } else if (
      collection instanceof TemplatesClass ||
      collection instanceof SignalComponent
    ) {
      throw new TypeError(
        "tiny.Signals(tools, define) imports signals, handlers and constants only.",
      );
    } else {
      imported.add("fn");
    }
  }
  const factory = importedShapeFactory(define as AnyFunction, imported);
  // Taken now, while the definition's own line is on the stack.
  const site = cache.trustCache ? undefined : importCallSite();
  return async () => {
    await importsAt(site, list);
    return factory;
  };
}

/**
 * The `signal` a factory reading other collections sees on the server: the
 * signals of their graphs for the current run.
 */
function upstreamSignals(upstream: SignalUpstream): object {
  return new Proxy(Object.create(null), {
    get(_, name) {
      const signal = upstream.current[name as string];
      if (signal instanceof InstanceSignalHandle) {
        throw new TypeError(
          `signal.${
            String(name)
          } is per-instance: another collection cannot read it.`,
        );
      }
      return signal;
    },
  });
}

/** What each `collection.withInputs()` stands for, for `tiny.imports()`. */
const signalInputs = new WeakMap<object, SignalEvaluation>();

type SignalEvaluation = {
  collection: SignalsClass;
  inputs: Record<string, unknown>;
  seed?: Record<string, unknown>;
};

/**
 * The collections whose signals a `tiny.Signals(tools, define)` collection
 * reads. Each server run of its factory first builds their graphs, with the
 * inputs `tiny.imports()` gave them in `evaluations`, into `current`, which
 * the factory's `signal` reads.
 */
type SignalUpstream = {
  collections: SignalsClass[];
  current: Record<string, unknown>;
  evaluations?: ReadonlyMap<SignalsClass, SignalEvaluation>;
};

class SignalsClass extends HandlersClass {
  protected override get stateful(): boolean {
    return true;
  }

  protected override get bundleKind(): "signal" {
    return "signal";
  }

  #prelude: { code: string; files: string[] };
  #actionHandlers: ReadonlySet<string>;
  /** The compiled factory; set once an async definition has resolved. */
  #compiled: { factory?: SignalFactory };
  #deferred: boolean;

  #upstream: SignalUpstream;

  /**
   * `(factory)` or `(import.meta.url, factory)`; either may be plain values.
   * Tools between them, one or an array (`(import.meta.url, [a, b],
   * define)`), are imported and passed to `define`, which returns computeds
   * as functions and writable signals as values.
   */
  constructor(...args: unknown[]) {
    const upstream: SignalUpstream = { collections: [], current: {} };
    const sourced = args.length > 1 &&
      (args[0] === undefined || typeof args[0] === "string" ||
        args[0] instanceof URL);
    const rest = sourced ? args.slice(1) : args;
    if (rest.length > 2) {
      throw new TypeError(
        "tiny.Signals takes its tools as one argument: an array for several, ([a, b], define).",
      );
    }
    if (rest.length === 2) {
      args = [
        sourced ? args[0] : undefined,
        importingDefinition(rest, upstream),
      ];
    }
    const [sourceFileUrl, given] = sourceAndDefinition<
      SignalFactory | SignalDefinition | Record<string, SignalValue>
    >("Signals", args);
    const factoryOrDefinition = typeof given === "function"
      ? given
      : valuesFactory(given);
    const deferred = factoryOrDefinition instanceof AsyncFunction;
    if (deferred && factoryOrDefinition.length > 0) {
      throw new TypeError(
        "An async Signals definition takes no parameters: it imports handlers and returns the factory.",
      );
    }
    const compiled: { factory?: SignalFactory } = deferred ? {} : {
      factory: compileSignalFactory(factoryOrDefinition as SignalFactory),
    };
    const prelude = { code: "", files: [] as string[] };
    const actionHandlers = new Set<string>();
    const owner: { collection?: SignalsClass } = {};
    super(sourceFileUrl, async () => {
      const scope = handlerDefinitionScope.getStore()!;
      let factory = factoryOrDefinition as SignalFactory;
      if (deferred) {
        factory = await (factoryOrDefinition as SignalDefinition)();
        if (
          typeof factory !== "function" || factory instanceof AsyncFunction
        ) {
          throw new TypeError(
            "An async Signals definition must resolve to a synchronous factory: return ({ Signal }) => ({ ... }).",
          );
        }
        if (scope.imports) {
          checkDefinitionImports(scope.imports, factory.toString());
          // Checked: the accessors this returns are generated, not shipped.
          scope.imports = undefined;
        }
        const imported = upstream.collections.length > 0;
        const run = compileSignalFactory(factory, {
          references: serverReferences(scope.dependencies, imported),
          constants: scope.constants,
          signal: imported ? upstreamSignals(upstream) : undefined,
        });
        compiled.factory = imported
          ? (tools) => {
            upstream.current = Object.assign(
              {},
              ...upstream.collections.map((collection) =>
                collection._graph(upstream.evaluations)
              ),
            );
            return run(tools);
          }
          : run;
      }
      const signals = signalNames(compiled.factory!);
      // Each action (`signal.size.update`) is exported as a handler of its own.
      actionHandlers.clear();
      for (const [name, actions] of signals) {
        for (const action of actions) {
          const handler = signalActionHandler(name, action);
          if (signals.has(handler)) {
            throw new TypeError(
              `Signal '${handler}' clashes with the handler of signal.${name}.${action}: rename it.`,
            );
          }
          actionHandlers.add(handler);
        }
      }
      const names = [...signals.keys()];
      const declarations = constantsDeclaration(scope.constants);
      // Module-level names in the bundle must not collide with signal exports.
      const taken = new Set([
        ...names,
        ...actionHandlers,
        ...SIGNAL_BUNDLE_RESERVED,
      ]);
      const free = (base: string) => {
        let name = base;
        for (let index = 2; taken.has(name); index++) name = `${base}${index}`;
        taken.add(name);
        return name;
      };
      // Bind the toolkit to the factory's own parameter, importing only the
      // runtime modules it names, and run its body once:
      // `import { SignalInstance as Signal } from "./tt-signal_….js";`
      // followed by `const signals = (() => {...})();`. Factories of other
      // shapes are called with the whole toolkit instead.
      const instanceKey = owner.collection!.instanceKey;
      const split = splitFactory(factory.toString());
      const parameterNames = split?.parameter.match(/[$A-Z_a-z][$\w]*/g) ??
        [];
      let graph: string;
      let tools: ReturnType<typeof signalToolsPrelude>;
      if (split && !parameterNames.some((name) => taken.has(name))) {
        parameterNames.forEach((name) => taken.add(name));
        graph = free("signals");
        tools = signalToolsPrelude(split.parameter, instanceKey);
        prelude.code = [
          declarations + tools.code,
          `const ${graph} = (${split.body})();`,
        ].filter(Boolean).join("\n");
      } else {
        const define = free("defineSignals");
        graph = free("signals");
        tools = signalToolsPrelude(undefined, instanceKey);
        prelude.code = declarations + tools.code + "\n" +
          `const ${define} = ${factory};\n` +
          `const ${graph} = ${define}(${tools.tools});`;
      }
      // Each signal without a name is named after its key, as on the server.
      prelude.code +=
        `\nfor (const [name, signal] of Object.entries(${graph})) ` +
        `if (signal instanceof EventTarget) signal.name ??= name;`;
      prelude.files = tools.files;
      return Object.fromEntries(names.flatMap((name) => {
        const property = /^[$A-Z_a-z][$\w]*$/.test(name)
          ? `.${name}`
          : `[${JSON.stringify(name)}]`;
        return [
          [
            name,
            handlerFromSource(`function (event) {
            return ${graph}${property}.handleEvent(this, event);
          }`),
          ],
          ...signals.get(name)!.map((action) => [
            signalActionHandler(name, action),
            handlerFromSource(`function (event) {
            return ${graph}${property}.${action}(this, event);
          }`),
          ]),
        ];
      }));
    });
    this.#actionHandlers = actionHandlers;
    this.#prelude = prelude;
    owner.collection = this;
    this.#compiled = compiled;
    this.#deferred = deferred;
    this.#upstream = upstream;
  }

  /**
   * Identifies this collection's instance roots. Derived from the source file
   * and construction order rather than the bundle filename, which hashes the
   * code this key is compiled into.
   */
  get instanceKey(): string {
    const baseName = this.sourceFileUrl.replace(/\\/g, "/").split("/").pop()
      ?.replace(/\.[^.]+$/, "").replace(/\W/g, "_") || "signals";
    return `${baseName}_${
      generateHandlerHash(`${this.sourceFileUrl}#${this._bundleIndex}`)
    }`;
  }

  /**
   * Whether `name` is the handler of a signal's action (`size$update`)
   * rather than of a signal: it is reached only from JSX, as
   * `signal.size.update`.
   */
  _isActionHandler(name: string): boolean {
    return this.#actionHandlers.has(name);
  }

  #levels?: { leaves: string[]; enclosing: string[] };

  /**
   * The keys of the innermost per-instance levels, whose roots a component
   * instance's root is, and of the levels enclosing them, whose roots the
   * page provides around it.
   */
  _instanceLevels(): { leaves: string[]; enclosing: string[] } {
    if (this.#levels) return this.#levels;
    const graph = runSignalFactory(
      this.#compiled.factory!,
      signalClasses(false, this.instanceKey),
    );
    const leaves = new Set<string>();
    const enclosing = new Set<string>();
    const groupsIn = (signals: Record<string, unknown>) =>
      new Set(
        Object.values(signals).flatMap((signal) =>
          signal instanceof InstanceSignalHandle ? [signal.group] : []
        ),
      );
    const visit = (group: InstanceGroup) => {
      const children = groupsIn(group.template);
      (children.size ? enclosing : leaves).add(group.key);
      children.forEach(visit);
    };
    groupsIn(graph).forEach(visit);
    return this.#levels = {
      leaves: [...leaves],
      enclosing: [...enclosing],
    };
  }

  /** Must match the key `perInstance(name, ...)` builds in signals.ts. */
  instanceKeyFor(name: string): string {
    return `${this.instanceKey}-${name}`;
  }

  seed(values: Record<string, unknown>): string {
    return JSON.stringify({ [this.instanceKey]: values });
  }

  seedFor(name: string, values: Record<string, unknown>): string {
    return JSON.stringify({ [this.instanceKeyFor(name)]: values });
  }

  /**
   * `evaluateUsingInitialValues()` for a collection already defined, with
   * the inputs `tiny.imports()` gave the collections it reads.
   */
  _initialValues(
    inputs: Record<string, unknown> = {},
    seed?: Record<string, unknown>,
    evaluations?: ReadonlyMap<SignalsClass, SignalEvaluation>,
  ): Record<string, unknown> {
    this.#upstream.evaluations = evaluations;
    try {
      return this.#evaluate(inputs, seed);
    } finally {
      this.#upstream.evaluations = undefined;
    }
  }

  /** A fresh graph of this collection's signals, for one that reads them. */
  _graph(
    evaluations?: ReadonlyMap<SignalsClass, SignalEvaluation>,
  ): Record<string, unknown> {
    this.#upstream.evaluations = evaluations;
    try {
      return this.#build(evaluations?.get(this)?.inputs ?? {}).graph;
    } finally {
      this.#upstream.evaluations = undefined;
    }
  }

  withInputs(
    inputs: Record<string, unknown> = {},
    seed?: Record<string, unknown>,
  ): this {
    // Members run on the collection, so its private fields stay reachable.
    const withInputs = new Proxy(this, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    signalInputs.set(withInputs, { collection: this, inputs, seed });
    return withInputs;
  }

  evaluateUsingInitialValues(
    inputs: Record<string, unknown> = {},
    seed?: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    if (this.#deferred) {
      return this.ensureDefined().then(() => this.#evaluate(inputs, seed));
    }
    return this.#evaluate(inputs, seed);
  }

  /** Runs the factory with `inputs` written to its writable signals. */
  #build(
    inputs: Record<string, unknown>,
  ): { tools: InternalSignalTools; graph: SignalDefinitions } {
    const tools: InternalSignalTools = signalClasses(true, this.instanceKey);
    const graph = runSignalFactory(this.#compiled.factory!, tools);
    for (const [name, value] of Object.entries(inputs)) {
      if (!Object.hasOwn(graph, name)) {
        throw new TypeError(
          `Signal '${name}' is not defined in this collection.`,
        );
      }
      if (graph[name] instanceof tools.InstanceSignal) {
        throw new TypeError(
          `Signal '${name}' is per-instance and cannot be set here.`,
        );
      }
      // Assigning to a computed signal throws: only writable signals are inputs.
      (graph[name] as { value: unknown }).value = value;
    }
    return { tools, graph };
  }

  #evaluate(
    inputs: Record<string, unknown>,
    seed?: Record<string, unknown>,
  ): Record<string, unknown> {
    const { tools, graph } = this.#build(inputs);
    for (const name of Object.keys(seed ?? {})) {
      if (!(graph[name] instanceof tools.InstanceSignal)) {
        throw new TypeError(
          `Cannot seed '${name}': it is not a per-instance signal of this collection.`,
        );
      }
    }
    // Per-instance signals report the value of one instance, started from
    // `seed` when given and fresh otherwise; `.all` aggregates see no
    // instances on the server.
    const instances = new Map();
    return Object.fromEntries(
      Object.entries(graph).map(([name, signal]) => [
        name,
        !(signal instanceof tools.InstanceSignal)
          ? (signal as { value: unknown }).value
          : seed
          ? signal.seededValue(seed, instances)
          : signal.initialValue,
      ]),
    );
  }

  protected override get bundlePrelude(): string {
    return this.#prelude.code;
  }

  protected override get bundleRuntimeFiles(): Iterable<string> {
    return this.#prelude.files;
  }
}

class StylesClass extends ClientToolsClass<Empty, Empty, Empty> {
  constructor(
    sourceFileUrlOrStyles:
      | string
      | URL
      | undefined
      | Record<string, ScopedStyleInput>,
    stylesArg?: Record<string, ScopedStyleInput>,
  ) {
    // Detect whether first arg is the styles object (no sourceFileUrl provided)
    const firstArgIsStyles = sourceFileUrlOrStyles !== null &&
      sourceFileUrlOrStyles !== undefined &&
      typeof sourceFileUrlOrStyles === "object" &&
      !(sourceFileUrlOrStyles instanceof URL);

    if ((firstArgIsStyles && stylesArg !== undefined) || arguments.length > 2) {
      throw new TypeError("tiny.Styles does not accept constructor options.");
    }

    const sourceFileUrl = firstArgIsStyles
      ? undefined
      : sourceFileUrlOrStyles as string | URL | undefined;
    const styles =
      (firstArgIsStyles ? sourceFileUrlOrStyles : stylesArg) as Record<
        string,
        ScopedStyleInput
      >;

    noteUnsourced("Styles", sourceFileUrl);
    super(sourceFileUrl, { styles });
  }
}

// ============================================================================
// Templates
// ============================================================================

/** What a `tiny.Templates` entry renders: a JSX element, possibly async. */
type TemplateDefinitions = Record<string, () => unknown>;

/** Values for the `$[name]` placeholders of a template's markup. */
export type TemplateParams = Readonly<Record<string, string | undefined>>;

/**
 * A clone of a template. In the browser it is a `DocumentFragment` to
 * insert; on the server it is the markup as raw HTML to render. The type
 * covers both so one handler definition serves both sides.
 */
export type TemplateFragment = DocumentFragment & HtmlEscapedString;

/** One clone function per template, under the entry's name. */
export type TemplateClones<Definitions> = {
  readonly [Name in keyof Definitions]:
    & ((params?: TemplateParams) => TemplateFragment)
    & {
      /**
       * `<bundle>.<name>`: names the clone for the browser, as
       * `BuildFromTemplate`'s `template` prop or a `data-template`
       * attribute. Reading it while rendering records the bundle for the
       * page, so the clone is there when the browser asks for it.
       */
      readonly reference: string;
    };
};

/** A template's markup and the assets it was rendered with. */
export type RenderedTemplate = {
  readonly markup: string;
  /** Handler bundle files (`<bundle>.js`) the markup binds to. */
  readonly handlerFiles: readonly string[];
  /** Style bundle files (`<bundle>.css`) the markup's classes come from. */
  readonly styleFiles: readonly string[];
  /** Custom tags in the markup that `UpgradeCustomElement` gave lifecycle handlers. */
  readonly lifecycleTags: readonly string[];
};

/** A `tiny.Templates` collection. */
type TemplatesCollection<Definitions extends TemplateDefinitions> =
  & ClientToolsClass<TemplateClones<Definitions>, Empty, Empty>
  & {
    readonly _isTemplates: true;
    /** The rendered template of `name`, once the collection is defined. */
    rendered(name: keyof Definitions & string): RenderedTemplate | undefined;
  };

interface TemplatesConstructor {
  /**
   * Markup rendered once on the server and shipped in a bundle, for handlers
   * to clone: `new tiny.Templates({ row: () => <Row /> })`.
   * Each entry renders when the collection is first needed, with every
   * handler and stylesheet its markup used recorded, so a page loading a
   * handler that imports the collection also gets those stylesheets.
   */
  new <Definitions extends TemplateDefinitions>(
    templates: Definitions,
  ): TemplatesCollection<Definitions>;
  /** As above, with `import.meta.url` (see `HandlersConstructor`). */
  new <Definitions extends TemplateDefinitions>(
    sourceFileUrl: string | URL,
    templates: Definitions,
  ): TemplatesCollection<Definitions>;
}

/** Renders a JSX result to its markup, as the core renderer does. */
async function renderToMarkup(child: unknown): Promise<string> {
  try {
    const resolved = await child;
    return resolved == null || typeof resolved === "boolean"
      ? ""
      : String(await (resolved as { toString(): unknown }).toString());
  } catch (error) {
    if (error instanceof Promise) {
      await error;
      return renderToMarkup(child);
    }
    throw error;
  }
}

/**
 * The browser source of one clone function. `markup` is spliced in as a
 * string literal, so the function has no free variables and runs unchanged
 * on the server, where it returns the markup. Params are text: escaped, so
 * a value is never parsed as markup, in an attribute or between tags.
 */
function templateCloneSource(markup: string): string {
  return `function (params) {
  let markup = ${JSON.stringify(markup)};
  if (params) {
    markup = markup.replace(
      /\\$\\[([^\\]]+)\\]/g,
      (_placeholder, key) =>
        Object.hasOwn(params, key)
          ? String(params[key] ?? "").replace(
            /[&<>"']/g,
            (ch) => "&#" + ch.charCodeAt(0) + ";",
          )
          : "",
    );
  }
  if (typeof document === "undefined") return markup;
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.cloneNode(true);
}`;
}

/**
 * Module-level code adding the stylesheets the templates need to the head,
 * for a template bundle that reaches a page the server did not prepare for
 * it. Links the server already emitted are left alone.
 */
function templateStylesPrelude(styleFiles: Iterable<string>): string {
  const hrefs = [...new Set(styleFiles)].map((file) => `/styles/${file}`);
  if (!hrefs.length) return "";
  return `const templateStyles = ${JSON.stringify(hrefs)};
if (typeof document !== "undefined") {
  for (const href of templateStyles) {
    if (document.head.querySelector(\`link[rel="stylesheet"][href="\${href}"]\`)) {
      continue;
    }
    document.head.append(
      Object.assign(document.createElement("link"), { rel: "stylesheet", href }),
    );
  }
}
`;
}

/** Strips the extension `tiny.imports()` adds when recording asset usage. */
function assetName(file: string): string {
  return file.replace(/\.(js|css)$/, "");
}

class TemplatesClass extends ClientToolsClass<Empty, Empty, Empty> {
  readonly _isTemplates = true as const;

  protected override get bundleKind(): "template" {
    return "template";
  }

  #rendered = new Map<string, RenderedTemplate>();
  #prelude = "";
  #styleFiles = new Set<string>();

  /** `(templates)` or `(import.meta.url, templates)`. */
  constructor(...args: unknown[]) {
    const [sourceFileUrl, templates] = sourceAndDefinition<
      TemplateDefinitions
    >("Templates", args);
    if (
      !templates || typeof templates !== "object" ||
      Object.values(templates).some((entry) => typeof entry !== "function")
    ) {
      throw new TypeError(
        "tiny.Templates takes an object of functions returning JSX.",
      );
    }
    super(sourceFileUrl);
    this.defineDeferred(async (scope) => {
      const functions: Record<string, AnyFunction> = {};
      const dependencies = new Map<string, ClientFunctionImpl>();
      const lifecycleTags = new Set<string>();
      for (const [name, define] of Object.entries(templates)) {
        const tracker = createNoContextToolUsageTracker();
        // Rendered outside any request, so `tiny.imports()` gives real
        // references and records the assets they resolve to here; the owner
        // still counts as the caller for circular definition checks.
        const markup = await withNoContextToolUsageTracker(
          tracker,
          () =>
            requestFreeContext(() =>
              handlerDefinitionScope.run(
                { ...scope, active: false, rendering: true },
                () => renderToMarkup(define()),
              )
            ),
        );
        const rendered: RenderedTemplate = {
          markup,
          handlerFiles: [...tracker.accessedHandlerFiles],
          styleFiles: [...tracker.accessedStyleFiles],
          lifecycleTags: [...tracker.accessedLifecycleTags],
        };
        this.#rendered.set(name, rendered);
        for (const file of rendered.styleFiles) this.#styleFiles.add(file);
        // Upgraded elements in the markup need their tags defined wherever a
        // clone lands, so this bundle defines them itself when it loads.
        for (const tag of rendered.lifecycleTags) lifecycleTags.add(tag);
        // The bundles the markup binds to are dependencies of this one: its
        // filename follows theirs, and a page preloads them alongside it.
        for (const file of rendered.handlerFiles) {
          const impl = bundleByFilename(file)?.functions.values().next().value;
          if (impl) dependencies.set(`markup:${assetName(file)}`, impl);
        }
        functions[name] = handlerFromSource(templateCloneSource(markup));
      }
      this.#prelude = [
        templateStylesPrelude(this.#styleFiles),
        lifecycleDefinitionsPrelude(lifecycleTags),
      ].filter(Boolean).join("\n");
      this._processFunctions(functions, dependencies);
    });
  }

  protected override get bundlePrelude(): string {
    return this.#prelude;
  }

  protected override get bundleStyleFiles(): Iterable<string> {
    return this.#styleFiles;
  }

  /** The rendered template of `name`, once defined. */
  rendered(name: string): RenderedTemplate | undefined {
    return this.#rendered.get(name);
  }
}

/**
 * Markup rendered once on the server and shipped in a bundle, for handlers to
 * clone as `template.name()`: `new tiny.Templates({ row: () => <Row /> })`.
 */
export const Templates: TemplatesConstructor =
  TemplatesClass as unknown as TemplatesConstructor;

/**
 * A collection of functions that run in the browser, imported as `fn.*` and
 * bound to JSX event attributes: `new tiny.Handlers({ open() { ... } })`, or
 * an async factory that imports other tools first.
 */
export const Handlers: HandlersConstructor =
  HandlersClass as unknown as HandlersConstructor;

/**
 * A `tiny.Handlers` collection of these functions. An exported collection
 * states it, as JSR does not infer the types of a published module:
 * `export const tools: Handlers<{ open: (this: HTMLElement) => void }> =
 * new tiny.Handlers(import.meta.url, { open() { ... } })`. The handlers'
 * docs go on the type's members, where `fn.open` finds them.
 */
export type Handlers<TFunctions extends Record<string, AnyFunction>> =
  ClientToolsClass<TFunctions, Empty, Empty>;

/**
 * Reactive values shared across the page, imported as `signal.*`:
 * `new tiny.Signals({ count: 0 })`, or a factory building `Signal`s and
 * `Computed`s.
 */
export const Signals: SignalsConstructor =
  SignalsClass as unknown as SignalsConstructor;

/**
 * Scoped CSS blocks, imported as `styled.*`: each becomes a hashed class
 * name emitted inside an `@scope` rule:
 * ``new tiny.Styles({ card: css`padding: 16px;` })``.
 */
export const Styles: StylesConstructor =
  StylesClass as unknown as StylesConstructor;

/**
 * `collection` given `sourceFileUrl` first, unless a call passes its own.
 * Kept in this file so `importCallSite()` skips the trap's frame.
 */
export function sourcedConstructor<
  T extends abstract new (...args: never[]) => unknown,
>(
  collection: T,
  sourceFileUrl: string | URL,
): T {
  return new Proxy(collection, {
    construct: (target, args) =>
      Reflect.construct(
        target,
        typeof args[0] === "string" || args[0] instanceof URL
          ? args
          : [sourceFileUrl, ...args],
      ),
  });
}

// ============================================================================
// Components with instances
// ============================================================================

type AnySignalsCollection = AnyClientToolsInstance & {
  readonly _isSignals: true;
  readonly instanceKey: string;
};

/**
 * One instance of an imported signal component: the component itself, to
 * render as `<Box />`, with `signal` references that act on it from anywhere
 * on the page, whether or not `<Box />` itself is rendered: an element using
 * one carries the instance's `tt-link`, as its own root does. A `class` is
 * added to its root's own (`<Box class={styled.wide} />`); the component
 * never sees it.
 */
export type Instance<TSignals, Props, Result> =
  & ((props: Props & { class?: string }) => Result)
  & {
    readonly signal: SignalReferences<TSignals>;
  };

/**
 * A signal component as `tiny.imports()` returns it under `component`:
 * each `instance()` is a new instance of it.
 */
export type ImportedComponent<Name extends string, TSignals, Props, Result> = {
  readonly name: Name;
  instance(): Instance<TSignals, Props, Result>;
  /**
   * The `tt-instance` for an element enclosing instances, when the
   * component's signals have levels above its own: `<section
   * tt-instance={component.Name.scopeKey}>`. Signals at those levels are
   * shared by every instance inside that element.
   */
  readonly scopeKey: string;
  /**
   * The exposed signals, acting on whichever instance or enclosing element
   * the element using them sits in, rather than on one instance.
   */
  readonly signal: SignalReferences<TSignals>;
};

// deno-lint-ignore no-explicit-any
type AnyImportedComponent = ImportedComponent<string, any, any, any>;

/** One instance of each imported component, by name. */
export type ComponentInstances<TComponents> = {
  -readonly [Name in keyof TComponents]: TComponents[Name] extends
    ImportedComponent<string, infer TSignals, infer Props, infer Result>
    ? Instance<TSignals, Props, Result>
    : never;
};

/** `component.instance()` of a `tiny.imports()`. */
export type ComponentLinker<TComponents> = {
  /**
   * One copy of the imported components: an instance of each, by name,
   * all sharing one instance of their signals wherever they sit on the
   * page, so a box and its button are parts of one box. Name the copy and
   * use its parts by dot, so go-to-definition reaches them:
   * `const box = component.instance()`, then `<box.Box />`.
   */
  instance(): ComponentInstances<TComponents>;
  /**
   * `repeat` copies made together: each has its own instance of the
   * innermost level, and they share the levels enclosing it (see
   * `scopeKey`), so two boxes keep their own colour but share a recolor.
   * `const [one, two] = component.instance(2)`.
   */
  instance(repeat: number): ComponentInstances<TComponents>[];
  /**
   * The copy named `id`: every `instance(id)` with the same `id`, in any
   * request, is one copy, so parts rendered later (a row a server update
   * inserts, say) join the copy the page already shows. Name it for what
   * it belongs to, as two places sharing a name share their values:
   * `component.instance("recalls-selection")`.
   */
  instance(id: string): ComponentInstances<TComponents>;
};

declare const instancedBrand: unique symbol;

/**
 * What `instanced(render, [...])` makes: a component and the signals its
 * instances expose, for a `tiny.SignalComponent` factory to return by name.
 */
export type Instanced<TSignals, Props, Result> = {
  readonly [instancedBrand]: {
    signals: TSignals;
    props: Props;
    result: Result;
  };
};

/**
 * What `instanced()` makes, stated rather than inferred, for an exported
 * `tiny.SignalComponent`'s type (JSR does not infer the types of a published
 * module). `Signals` are the exposed signals as their collection defines
 * them, `InstanceSignals<{ open: Signal<boolean> }>` for a per-instance
 * `open`; `Props` the component's props.
 */
export type InstancedComponent<
  Signals extends SignalDefinitions = Empty,
  Props = Empty,
  Result = JSX.Element,
> = Instanced<SignalAccessors<Signals>, Props, Result>;

/**
 * The signals named by an `instanced()` list, by name: each reference's own
 * entry in its collection, so the editor still goes to its definition.
 */
type ExposedSignals<References extends readonly unknown[]> =
  [References[number]] extends [never] ? Empty
    : UnionToIntersection<
      References[number] extends SignalOrigin<infer Entry>
        ? Exclude<Entry, undefined>
        : never
    >;

/** The tools a `tiny.SignalComponent` factory receives. */
export type SignalComponentTools = {
  /**
   * Makes the factory's component, and names the signals other code may
   * drive on each instance: `instanced(() => <div />, [signal.press])`, with
   * signals from a `tiny.imports()` in the factory. Signals left out, or
   * all of them when there is no list, stay internal to the component.
   */
  instanced<
    Props,
    Result,
    const References extends readonly HandlerReference<string, unknown>[] = [],
  >(
    render: (props: Props) => Result,
    exposed?: References,
  ): Instanced<ExposedSignals<References>, Props, Result>;
  /** The same for a component without props: `instanced(<div />, [...])`. */
  instanced<
    const References extends readonly HandlerReference<string, unknown>[] = [],
  >(
    markup: JSX.Element,
    exposed?: References,
  ): Instanced<ExposedSignals<References>, Empty, JSX.Element>;
};

/** How a component given as a function or as markup renders, if it is one. */
function renderOf(value: unknown): InstancedParts["render"] | undefined {
  if (typeof value === "function") return value as InstancedParts["render"];
  if (isMarkup(value)) return () => value;
}

/**
 * Binds the signals of one request's `tiny.imports()` to the instance with
 * these `tt-link` tokens.
 */
type SignalSource = (links?: string) => SignalReferences<unknown>;

/** Each signal reference from a request's `tiny.imports()`, by its name. */
const signalSources = new WeakMap<
  object,
  { name: string; source: SignalSource }
>();

/**
 * The per-instance levels of the signal collections a `tiny.SignalComponent`
 * factory imports: its instance roots carry the innermost, and the page
 * provides roots for the enclosing ones.
 */
const signalComponentScope = new AsyncLocalStorage<
  { leaves: Set<string>; enclosing: Set<string> }
>();

type InstancedParts = {
  render: (props: Record<string, unknown>) => unknown;
  exposed: Map<string, SignalSource>;
};

const instancedParts = new WeakMap<object, InstancedParts>();

const signalComponentTools: SignalComponentTools = {
  instanced(
    component: unknown,
    references?: readonly HandlerReference<string, unknown>[],
  ) {
    const render = renderOf(component);
    if (!render) {
      throw new TypeError(
        "instanced() takes the component, a function or JSX, as its first argument: instanced(render, [signal.press]).",
      );
    }
    const exposed = new Map<string, SignalSource>();
    for (const reference of references ?? []) {
      const found = signalSources.get(reference);
      if (!found) {
        throw new TypeError(
          "instanced() exposes signals from a tiny.imports() in the factory: instanced(render, [signal.press]).",
        );
      }
      exposed.set(found.name, found.source);
    }
    const parts = {};
    instancedParts.set(parts, { render, exposed });
    return parts as never;
  },
};

/**
 * A component whose instances other code renders and drives. Like
 * `tiny.Signals`, it takes a factory; the factory imports what the component
 * renders with and returns its components by name,
 * `{ ColorBox: instanced(() => <div />, [signal.press]) }`; each is separate,
 * sharing only the factory's imports. `tiny.imports()` of it runs the
 * factory for the request and returns `component.ColorBox`,
 * whose `instance()` gives one instance to render as `<Instance />`
 * (its root links into that instance of the innermost level of every
 * collection the factory imported) and drive through `instance.signal`.
 */
export class SignalComponent<TComponents extends AnyInstancedComponents> {
  /** The factory passed in, run by each `tiny.imports()` of the component. */
  readonly factory: (
    tools: SignalComponentTools,
  ) => TComponents | Promise<TComponents>;

  /**
   * Takes the factory that imports what the components render with and
   * returns them by name.
   */
  constructor(
    factory: (
      tools: SignalComponentTools,
    ) => TComponents | Promise<TComponents>,
  ) {
    this.factory = factory;
  }
}

/**
 * What a `tiny.SignalComponent` factory returns: its components, by name,
 * each a plain function or JSX, or from `instanced()` to expose signals.
 */
type AnyInstancedComponents = Record<
  string,
  // deno-lint-ignore no-explicit-any
  Instanced<any, any, any> | ((props: any) => unknown) | JSX.Element
>;

type AnySignalComponent = SignalComponent<AnyInstancedComponents>;

/** The `component` of a `tiny.imports()` of signal components. */
type ExtractComponents<T> = T extends SignalComponent<infer TComponents> ? {
    readonly [
      // `keyof TComponents` alone (not `& string`) keeps each name linked to
      // the factory's entry, for the editor's go to definition.
      Name in keyof TComponents
    ]: TComponents[Name] extends
      Instanced<infer TSignals, infer Props, infer Result>
      ? ImportedComponent<Name & string, TSignals, Props, Result>
      : TComponents[Name] extends (props: infer Props) => infer Result
        ? ImportedComponent<Name & string, ExposedSignals<[]>, Props, Result>
      : TComponents[Name] extends JSX.Element ? ImportedComponent<
          Name & string,
          ExposedSignals<[]>,
          Empty,
          JSX.Element
        >
      : never;
  }
  : Empty;

/**
 * A new link id. Random, not counted per request: cached routes share one
 * document, where a repeated id would join unrelated instances, and a
 * server-wide count would show how much the server has rendered.
 */
function newLinkId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `link-${
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

type AnyInstance = Instance<unknown, Record<string, unknown>, unknown>;

/** The link ids of one copy from `component.instance()`, and of its group. */
type CopyLink = { group: string; copy: string };

/** The `component` of a request's `tiny.imports()`. */
function linkableComponents(
  components: (InstancedParts & {
    name: string;
    instanceKeys: string;
    enclosing: string[];
  })[],
): Record<string, AnyImportedComponent> & ComponentLinker<unknown> {
  const makers = new Map<string, (link?: CopyLink) => AnyInstance>();
  const imported: Record<string, AnyImportedComponent> = Object.fromEntries(
    components.map(({ name, render, exposed, instanceKeys, enclosing }) => {
      if (name === "instance") {
        throw new TypeError(
          "A tiny.SignalComponent can't name a component 'instance': component.instance() makes the instances.",
        );
      }
      const leaves = instanceKeys.split(" ").filter(Boolean);
      const make = (link?: CopyLink) => {
        // A copy's parts share every level, and the copies made together
        // share the outer ones. Alone, an instance links only the innermost
        // levels, and takes the outer ones from the element it sits in.
        const copy = link?.copy ?? newLinkId();
        const links = [
          ...(link ? enclosing.map((level) => `${level}=${link.group}`) : []),
          ...leaves.map((level) => `${level}=${copy}`),
        ].join(" ") || undefined;
        // A transparent part is the caller's markup, so its styles reach in.
        const attributes: Record<string, string> = {
          ...(isTransparent(render)
            ? {}
            : { [COMPONENT_ROOT_ATTRIBUTE]: name }),
          ...(links ? { "tt-link": links } : {}),
        };
        // Named after the component, for stack traces and devtools.
        const component = {
          [name]: ({ class: className, ...props }: Record<string, unknown>) =>
            markResult(
              render(props),
              className
                ? { ...attributes, class: String(className) }
                : attributes,
              props,
            ),
        }[name];
        return Object.assign(markedComponent(component), {
          signal: instanceSignals(exposed, links),
        });
      };
      const component: AnyImportedComponent = {
        name,
        scopeKey: enclosing.join(" "),
        signal: instanceSignals(exposed),
        instance: () => make(),
      };
      makers.set(name, make);
      return [name, component];
    }),
  );
  const instances = (group: string, copy: number) =>
    Object.fromEntries(
      [...makers].map((
        [name, make],
      ) => [name, make({ group, copy: `${group}.${copy}` })]),
    );
  return Object.assign(imported, {
    instance: ((repeat?: number | string) => {
      if (typeof repeat === "string") {
        // A link id is one token of `tt-link`'s `<level>=<id>` list.
        if (!/^[\w.:-]+$/.test(repeat)) {
          throw new TypeError(
            `component.instance(id) takes letters, digits and _ . : - for its id, not "${repeat}".`,
          );
        }
        return instances(repeat, 0);
      }
      const group = newLinkId();
      if (repeat === undefined) return instances(group, 0);
      if (!Number.isInteger(repeat) || repeat < 0) {
        throw new TypeError(
          `component.instance(repeat) takes a whole number of copies, not ${repeat}.`,
        );
      }
      return Array.from(
        { length: repeat },
        (_, copy) => instances(group, copy),
      );
    }) as ComponentLinker<unknown>["instance"],
  });
}

/**
 * One instance's references to the signals its component exposes, carrying
 * its `links`, or, with none, references resolving by ancestry.
 */
function instanceSignals(
  exposed: Map<string, SignalSource>,
  links?: string,
): SignalReferences<unknown> {
  const bound = new Map<SignalSource, SignalReferences<unknown>>();
  return new Proxy({}, {
    get(_target, name) {
      const source = typeof name === "string" ? exposed.get(name) : undefined;
      if (!source) return undefined;
      if (!bound.has(source)) bound.set(source, source(links));
      return (bound.get(source) as Record<string, unknown>)[name as string];
    },
  }) as SignalReferences<unknown>;
}

/**
 * A `tiny.imports()` argument as the unused-import report names it, with the
 * names it provides (a signal component's once its factory has run).
 */
function describeImport(
  item: object,
  componentNames: readonly string[] = [],
): ImportedCollection {
  const fileOf = (url: string) =>
    decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() ?? url);
  let kind: string;
  let names: string[];
  let file: string | undefined;
  let accessor: string | undefined;
  if (item instanceof ConstantsClass) {
    [kind, names, accessor] = [
      "Constants",
      Object.keys(item.values),
      "constants",
    ];
  } else if (item instanceof SignalComponent) {
    [kind, names] = ["SignalComponent", [...componentNames]];
  } else {
    const tool = item as AnyClientToolsInstance;
    [kind, accessor] = tool instanceof SignalsClass
      ? ["Signals", "signal"]
      : tool instanceof TemplatesClass
      ? ["Templates", "template"]
      : tool instanceof StylesClass
      ? ["Styles", "styled"]
      : ["Handlers", "fn"];
    names = [
      ...(tool instanceof StylesClass
        ? tool._styles.keys()
        : tool._handlerDefinitions.keys()),
    ].filter((name) =>
      !(tool instanceof SignalsClass && tool._isActionHandler(name))
    );
    file = fileOf(
      (tool as unknown as { sourceFileUrl: string }).sourceFileUrl ?? "",
    );
  }
  const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ", …" : "");
  return {
    key: item,
    label: `${kind}${file ? ` in ${file}` : ""} (${shown || "nothing"})`,
    names,
    accessor,
  };
}

/** The tool in `chain` that provides `name`, as the proxies resolve it: the last. */
function providerOf<Tool extends ToolResolutionTarget>(
  chain: readonly Tool[],
  filenames: (tool: Tool) => ReadonlyMap<string, string>,
  name: PropertyKey,
): Tool | undefined {
  if (typeof name !== "string") return undefined;
  return chain.findLast((tool) => filenames(tool).has(name));
}

/** Values for `tiny.imports()`, read as `constants`. See {@link ConstantsClass}. */
export const Constants: new <Values extends SignalConstants>(
  values: Values,
) => ConstantsClass<Values> = ConstantsClass;

/**
 * The request's context and empty tools, as `c`. Throws outside a request.
 */
export async function imports(): Promise<ImportedTools<Empty, Empty>>;
/**
 * Resolves these collections for the current request or definition:
 * `const { fn, signal, styled, template, constants, c } = await
 * tiny.imports(handlers, styles)`. When several define the same name the
 * last one wins. Only the bundles accessed through the result are recorded
 * for the request and emitted by `AssetTags`.
 */
export async function imports<
  const TTools extends [Importable, ...Importable[]],
>(
  ...tools: TTools
): Promise<ImportsOf<TTools>>;
export function imports(
  ...given: Importable[]
): Promise<
  ImportedTools<unknown, unknown, unknown, unknown, unknown, unknown>
> {
  // Where the call is, for the unused-import report: taken before the first
  // await, while the caller is still on the stack.
  return importsAt(cache.trustCache ? undefined : importCallSite(), given);
}

/** `tiny.imports(...given)`, reporting unused imports against `site`. */
async function importsAt(
  site: string | undefined,
  given: readonly Importable[],
): Promise<
  ImportedTools<unknown, unknown, unknown, unknown, unknown, unknown>
> {
  const evaluations = new Map<SignalsClass, SignalEvaluation>();
  const components = given.filter((item) => item instanceof SignalComponent);
  const imported = [
    ...new Set(
      given.filter((item) => !(item instanceof SignalComponent)).map((item) => {
        const evaluation = signalInputs.get(item as AnyClientToolsInstance);
        if (!evaluation) return item;
        evaluations.set(evaluation.collection, evaluation);
        return evaluation.collection;
      }),
    ),
  ] as (AnyClientToolsInstance | ConstantsClass<SignalConstants>)[];
  const constantSets = imported.filter((item) =>
    item instanceof ConstantsClass
  );
  const tools = imported.filter((item): item is AnyClientToolsInstance =>
    !(item instanceof ConstantsClass)
  );
  const definition = handlerDefinitionScope.getStore();
  if (definition?.active) {
    if (components.length) {
      throw new Error(
        "Components cannot be imported inside a handler definition; import their signals collection instead.",
      );
    }
    if (imported.length === 0) {
      throw new Error(
        "Handler definitions require explicit tools in tiny.imports().",
      );
    }
    if (constantSets.length > 0) {
      mergeConstants(definition.constants ??= {}, constantSets);
    }
    await Promise.all(tools.map((tool) => tool.ensureDefined()));
    if (site) {
      (definition.imports ??= []).push({
        site,
        collections: imported.map((item) => describeImport(item)),
      });
    }
    const references: Record<string, AnyFunction> = Object.create(null);
    const signalReferences: Record<string, unknown> = Object.create(null);
    const templateReferences: Record<string, AnyFunction> = Object.create(
      null,
    );
    for (const tool of tools) {
      for (const [name, instance] of tool._handlerDefinitions) {
        const isSignal = tool instanceof SignalsClass;
        // Handlers read the signal itself; its actions are for JSX.
        if (isSignal && tool._isActionHandler(name)) continue;
        const isTemplate = tool instanceof TemplatesClass;
        const dependencyName = isSignal
          ? `signal:${name}`
          : isTemplate
          ? `template:${name}`
          : name;
        if (definition.dependencies.has(dependencyName)) {
          throw new Error(
            `Duplicate imported handler '${name}' in handler definition.`,
          );
        }
        definition.dependencies.set(dependencyName, instance);
        const unavailable = () =>
          new Error(
            `Handler '${name}' cannot be called during server-side definition. Call it inside a returned handler.`,
          );
        if (isTemplate) {
          // On the server a clone is the markup; `raw` keeps it unescaped.
          templateReferences[name] = Object.defineProperty(
            function (params?: TemplateParams) {
              if (definition.active) throw unavailable();
              return raw(instance.fn(params));
            },
            "reference",
            { get: () => instance.reference },
          );
          continue;
        }
        if (isSignal) {
          Object.defineProperty(signalReferences, name, {
            enumerable: true,
            get() {
              if (definition.active) throw unavailable();
              return instance.fn();
            },
          });
          continue;
        }
        references[name] = function (this: unknown, ...args: unknown[]) {
          if (definition.active) throw unavailable();
          return Reflect.apply(instance.fn, this, args);
        };
      }
    }
    const unsupported = () => {
      throw new Error(
        "Handler definitions support only fn from tiny.imports(); request tools are unavailable.",
      );
    };
    return {
      constants: JSON.parse(JSON.stringify(definition.constants ?? {})),
      signal: signalReferences as SignalReferences<unknown>,
      template: templateReferences,
      component: {} as ComponentLinker<unknown>,
      fn: new Proxy(references, {
        get(target, property) {
          if (
            typeof property !== "string" || !Object.hasOwn(target, property)
          ) {
            throw new Error(
              `Unknown definition handler '${
                String(property)
              }'. Rendering helpers are not available inside handler definitions.`,
            );
          }
          return target[property];
        },
      }) as unknown as HandlerReferences<unknown>,
      get styled() {
        return unsupported();
      },
      get c() {
        return unsupported();
      },
    };
  }
  const context = tryGetContext<{
    Variables: {
      accessedHandlerFiles: Set<string>;
      accessedStyleFiles: Set<string>;
    };
  }>();
  if (!context && imported.length === 0 && components.length === 0) {
    throw new Error(
      "tiny.imports() requires at least one TinyTools instance when no Hono request context is active.",
    );
  }
  await Promise.all(tools.map((tool) => tool.ensureBuilt()));
  /** Marks a collection as read, once the call's collections are known. */
  let use: (key: object | undefined) => void = () => {};
  const recordUsage = (type: ToolUsageType, filename: string) => {
    if (!context) {
      recordNoContextUsage(type, filename);
      return;
    }
    const key = type === "handler"
      ? "accessedHandlerFiles"
      : "accessedStyleFiles";
    const files = context.get(key) as Set<string> | undefined;
    files?.add(filename + (type === "handler" ? ".js" : ".css"));
  };
  const handlerTools = tools.filter((tool) =>
    !(tool instanceof SignalsClass) && !(tool instanceof TemplatesClass)
  );
  const handlers = new Proxy({}, {
    get: (_target, property) => {
      use(providerOf(handlerTools, (tool) => tool._handlerFilenames, property));
      return resolveToolAccessFromChain(
        handlerTools,
        "function",
        property,
        recordUsage,
      );
    },
  });
  const signals = tools.filter((tool) => tool instanceof SignalsClass);
  const templates = tools.filter((tool) => tool instanceof TemplatesClass);
  const rendering = signals.length
    ? await signalRendering(signals, evaluations, recordUsage)
    : undefined;
  // Rendering a template puts its markup on the page, so the page needs the
  // assets the markup was rendered with, as if it had rendered them itself.
  const template = new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined;
      for (let i = templates.length - 1; i >= 0; i--) {
        const rendered = templates[i].rendered(property);
        const instance = templates[i]._handlerDefinitions.get(property);
        if (!rendered || !instance) continue;
        use(templates[i]);
        const clone = (params?: TemplateParams) => {
          for (const file of rendered.handlerFiles) recordHandlerFile(file);
          for (const file of rendered.styleFiles) {
            recordUsage("style", assetName(file));
          }
          for (const tag of rendered.lifecycleTags) recordLifecycleTag(tag);
          return raw(instance.fn(params));
        };
        // Naming the clone for the browser means the page must load its
        // bundle, whose own code adds the stylesheets and tags the markup needs.
        return Object.defineProperty(clone, "reference", {
          get: () => {
            recordUsage("handler", instance.filename);
            return instance.reference;
          },
        });
      }
      return undefined;
    },
  });
  const styled = new Proxy({}, {
    get: (_target, property) => {
      use(providerOf(tools, (tool) => tool._styleFilenames, property));
      return resolveToolAccessFromChain(tools, "style", property, recordUsage);
    },
  });
  const resolveSignal = (name: string) => {
    // Unlike handlers, a signal name in two collections is never an
    // override: each element would silently bind to the last one.
    const owners = signals.filter((tool) => tool._handlerFilenames.has(name));
    if (owners.length > 1) {
      throw new Error(
        `Ambiguous signal '${name}': it is defined by the collections ${
          owners.map((tool) => `'${tool.instanceKey}'`).join(" and ")
        }. Import those collections in separate tiny.imports() calls.`,
      );
    }
    use(owners[0]);
    return resolveToolAccessFromChain(signals, "function", name, recordUsage);
  };
  const levels = signalComponentScope.getStore();
  for (const tool of levels ? signals : []) {
    const { leaves, enclosing } = tool._instanceLevels();
    leaves.forEach((key) => levels!.leaves.add(key));
    enclosing.forEach((key) => levels!.enclosing.add(key));
  }
  const source: SignalSource = (links) =>
    createSignalReferences(resolveSignal, rendering, links);
  const references = createSignalReferences(resolveSignal, rendering);
  // Remembers where each reference came from, for `instanced()`.
  const signal = new Proxy(references, {
    get(target, name, receiver) {
      const reference = Reflect.get(target, name, receiver);
      if (
        typeof name === "string" && reference && typeof reference === "object"
      ) {
        signalSources.set(reference, { name, source });
      }
      return reference;
    },
  });
  const instancedComponents = await Promise.all(
    (components as AnySignalComponent[]).map((component) => {
      const levels = {
        leaves: new Set<string>(),
        enclosing: new Set<string>(),
      };
      return signalComponentScope.run(levels, async () => {
        const entries = Object.entries(
          await component.factory(signalComponentTools) ?? {},
        );
        return entries.map(([name, value]) => {
          // A plain function or markup is a component that exposes no
          // signals.
          const render = instancedParts.has(value)
            ? undefined
            : renderOf(value);
          const parts = render
            ? { render, exposed: new Map<string, SignalSource>() }
            : instancedParts.get(value);
          if (!parts) {
            throw new TypeError(
              `A tiny.SignalComponent factory returns its components by name, each a function, JSX or from instanced(): '${name}' is none of these.`,
            );
          }
          return {
            ...parts,
            name,
            owner: component,
            instanceKeys: [...levels.leaves].join(" "),
            enclosing: [...levels.enclosing],
          };
        });
      });
    }),
  ).then((lists) => lists.flat());
  let constants = mergeConstants({}, constantSets);
  let component = linkableComponents(instancedComponents);
  if (site) {
    const componentOwners = new Map<string, object>(
      instancedComponents.map(({ name, owner }) => [name, owner]),
    );
    use = trackImports(site, [
      ...imported.map((item) => describeImport(item)),
      ...components.map((owner) =>
        describeImport(
          owner,
          instancedComponents.filter((part) => part.owner === owner)
            .map(({ name }) => name),
        )
      ),
    ]);
    constants = new Proxy(constants, {
      get(target, name, receiver) {
        if (typeof name === "string") {
          use(constantSets.find((set) => Object.hasOwn(set.values, name)));
        }
        return Reflect.get(target, name, receiver);
      },
    });
    // A part read from the linker, or from the copies it makes, is a read
    // of the component that defines it.
    const parts = <Parts extends object>(made: Parts): Parts =>
      new Proxy(made, {
        get(target, name, receiver) {
          if (typeof name === "string") use(componentOwners.get(name));
          return Reflect.get(target, name, receiver);
        },
      });
    const linker = component;
    component = parts(
      {
        ...linker,
        instance: ((repeat?: number) => {
          const made = linker.instance(repeat as number);
          return Array.isArray(made) ? made.map(parts) : parts(made);
        }) as ComponentLinker<unknown>["instance"],
      } as typeof linker,
    );
  }
  return {
    constants,
    signal,
    fn: createHandlerReferences((name) =>
      (handlers as Record<string, unknown>)[name]
    ),
    template,
    component,
    styled: styled as ActivateScopedStyles<unknown>,
    get c(): Context {
      if (!context) {
        throw new Error("tiny.imports() has no active Hono request context.");
      }
      return context;
    },
  };
}

/**
 * Defines every registered collection now, so each definition's unused
 * `tiny.imports()` arguments are warned about at startup rather than when a
 * page first loads it (`--lazy` defines on demand). Does nothing in prod mode.
 * Call it in the background once the app's modules are imported.
 */
export async function checkDefinitionImportsNow(): Promise<void> {
  if (cache.trustCache) return;
  for (const tools of [...registeredClientTools]) {
    await tools.ensureDefined();
  }
  const found = unusedImports().filter(({ definition }) => definition);
  console.log(
    found.length
      ? `[tiny-tools] ${found.length} definition(s) import what they never use (warned above).`
      : "[tiny-tools] No unused tiny.imports() in definitions.",
  );
}

/**
 * Registers `signalBindingTools` for a build when the app defines a `tiny.Signals`
 * collection, since a signal placed as a JSX child renders with its
 * `setTextContent`. Otherwise it is loaded only by the first `tiny.imports()`
 * of a signal, after the build, so its bundle would be missing from a fresh
 * build. An app without signals never loads it.
 */
export async function registerSignalTextTools(): Promise<void> {
  for (const tools of registeredClientTools) {
    if (tools instanceof SignalsClass) {
      await import("./handlers/signals.ts");
      return;
    }
  }
}

/**
 * Implements `signal.name.initial` and a signal reference placed as a JSX
 * child, which renders the initial value inside `<signal-text
 * onConnect={signal} onSignal={fn.setTextContent}>`, so the text is there
 * before any script runs and follows each change after; a custom element is
 * inline, like a span.
 * Both must be synchronous to sit inline in JSX, so `signalBindingTools` is built
 * here, ahead of any use. Both modules are loaded lazily: they import this one.
 */
async function signalRendering(
  signals: readonly SignalsClass[],
  evaluations: ReadonlyMap<SignalsClass, SignalEvaluation>,
  recordUsage: (type: ToolUsageType, filename: string) => void,
): Promise<SignalRendering> {
  const [{ signalBindingTools }, { jsx }] = await Promise.all([
    import("./handlers/signals.ts"),
    import("./jsx-runtime.ts"),
  ]);
  await signalBindingTools.ensureBuilt();
  const fn = createHandlerReferences<
    Record<"setTextContent" | "setBound", unknown>
  >(
    (name) =>
      resolveToolAccessFromChain(
        [signalBindingTools],
        "function",
        name,
        recordUsage,
      ),
  );
  // Each collection's factory runs once per tiny.imports(), on first use.
  const initialValues = new Map<SignalsClass, Record<string, unknown>>();
  const initial = (name: string) => {
    const owner = signals.findLast((tool) => tool._handlerFilenames.has(name))!;
    if (!initialValues.has(owner)) {
      const evaluation = evaluations.get(owner);
      initialValues.set(
        owner,
        owner._initialValues(
          evaluation?.inputs,
          evaluation?.seed,
          evaluations,
        ),
      );
    }
    return initialValues.get(owner)![name];
  };
  return {
    initial,
    text: (reference, initialText) =>
      jsx("signal-text", {
        onConnect: reference,
        onSignal: fn.setTextContent,
        // Written as setTextContent writes it.
        children: `${initialText}`,
        // A JSXNode renders like the Element JSX expressions are typed as.
      }) as unknown as JSX.Element,
    setter: () => fn.setBound as object,
  };
}

/** Type alias for external use - represents a ClientTools instance */
// deno-lint-ignore no-explicit-any
export type ClientTools<F = any, S = any, G = any> = ClientToolsClass<F, S, G>;

/** Export for use in build process to check if handlers have dependencies that changed */
export { changedHandlerKeys };
