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

import type {
  ActivateClientFunctions,
  BrandAsClientFunction as _BrandAsClientFunction,
} from "./jsx-runtime.ts";
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
import {
  type InstanceLevels,
  type SignalAccessors,
  signalClasses,
  type SignalDefinitions,
  type SignalInputs,
  type SignalTools,
  type SignalValues,
} from "./signals.ts";
import {
  createEvents,
  createHandlerReferences,
  createSignalReferences,
  type Events,
  type HandlerReferences,
  type SignalReferences,
} from "./eventAttributes.ts";

// Import shared registries from registry modules
import {
  changedHandlerKeys,
  type ClientFunctionImpl,
  filesWithChangedHandlers,
  getImportRegistry,
  HandlerBundle,
} from "./clientFunctions.ts";
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
};

export interface ToolResolutionTarget {
  readonly _handlerFilenames: ReadonlyMap<string, string>;
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

export function resolveToolAccessFromChain(
  toolsChain: readonly ToolResolutionTarget[],
  mode: ToolResolutionMode,
  prop: PropertyKey,
  onUsage?: (type: ToolUsageType, filename: string) => void,
): unknown {
  if (
    mode === "function" &&
    (prop === "multiHandler" || prop === "multiHandlerSync")
  ) {
    return (...handlerReferences: string[]) => {
      for (const reference of handlerReferences) {
        if (!/^handlers\.\w+\.[$\w]+\.call\(this, event\)$/.test(reference)) {
          throw new Error(
            `Cannot compose invalid handler reference: ${reference}`,
          );
        }
      }

      if (prop === "multiHandler") return handlerReferences.join(";");

      const calls = handlerReferences.map((reference) =>
        `if(await ${reference}===false)return;`
      ).join("");
      return `void (async()=>{${calls}})()`;
    };
  }

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

    if (mode === "function") {
      return (tools as unknown as Record<string, unknown>)[prop];
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

/** Extract functions type from a ClientTools instance */
type ExtractFunctions<T> = T extends { readonly _isSignals: true } ? Empty
  // deno-lint-ignore no-explicit-any
  : T extends ClientToolsClass<infer F, any, any> ? F
  : Empty;

/** Extract styles type from a ClientTools instance (excludes global styles) */
type ExtractStyles<T> = T extends { readonly _isSignals: true } ? Empty
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
export type ImportedTools<TFunctions, TStyles, TSignals = Empty> = {
  readonly events: Events<TFunctions>;
  readonly fn: HandlerReferences<TFunctions>;
  readonly signal: SignalReferences<TSignals>;
  readonly handlers: ActivateClientFunctions<TFunctions>;
  readonly styled: ActivateScopedStyles<TStyles>;
  readonly c: Context;
};

// deno-lint-ignore no-explicit-any
type AnyClientToolsInstance = ClientToolsClass<any, any, any>;

type ExtractSignals<T> = T extends { readonly _isSignals: true }
  // deno-lint-ignore no-explicit-any
  ? T extends ClientToolsClass<infer Functions, any, any> ? Functions : Empty
  : Empty;

type HandlerFactory<T extends Record<string, AnyFunction>> = () =>
  | T
  | Promise<T>;

type HandlerDefinitionScope = {
  owner: AnyClientToolsInstance;
  dependencies: Map<string, ClientFunctionImpl>;
  active: boolean;
};

const handlerDefinitionScope = new AsyncLocalStorage<HandlerDefinitionScope>();

// deno-lint-ignore no-explicit-any
type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends
  ((arg: infer I) => void) ? I : never;

// ============================================================================
// ClientTools Factory Class
// ============================================================================

/**
 * Options for creating a ClientTools instance.
 */
export interface ClientToolsOptions<
  TFunctions extends Record<string, AnyFunction> = Empty,
  TStyles extends Record<string, ScopedStyleInput> = Empty,
  // deno-lint-ignore no-explicit-any
  TImports extends ClientToolsClass<any, any, any>[] = [],
> {
  /** Client functions to define */
  functions?: TFunctions;
  /** Scoped styles to define */
  styles?: ForbidReservedStyledKeys<TStyles>;
  /** Other ClientTools instances to import functions and styles from */
  imports?: TImports;
}

export interface HandlersOptions<
  TImports extends AnyClientToolsInstance[] = [],
> {
  /** Other TinyTools instances to import functions and styles from */
  imports?: TImports;
}

/** Infer result type for ClientToolsOptions */
export type InferClientToolsOptions<T> = T extends ClientToolsOptions<
  infer TFunctions,
  infer TStyles,
  infer TImports
>
  // deno-lint-ignore no-explicit-any
  ? TImports extends ClientToolsClass<any, any, any>[] ? ClientToolsClass<
      TFunctions & UnionOfFunctions<TImports>,
      TStyles & UnionOfStyles<TImports>,
      Empty
    >
  : ClientToolsClass<TFunctions, TStyles, Empty>
  : never;

// deno-lint-ignore no-explicit-any
type FunctionsFromTool<T> = T extends ClientToolsClass<infer F, any, any> ? F
  : Empty;

// deno-lint-ignore no-explicit-any
type StylesFromTool<T> = T extends ClientToolsClass<any, infer S, any> ? S
  : Empty;

/** Helper to accumulate functions from an array of ClientTools (works with both tuples and arrays) */
// deno-lint-ignore no-explicit-any
type UnionOfFunctions<T extends ClientToolsClass<any, any, any>[]> =
  [T[number]] extends [never] ? Empty
    : UnionToIntersection<FunctionsFromTool<T[number]>>;

/** Helper to accumulate styles from an array of ClientTools (works with both tuples and arrays) */
// deno-lint-ignore no-explicit-any
type UnionOfStyles<T extends ClientToolsClass<any, any, any>[]> =
  [T[number]] extends [never] ? Empty
    : UnionToIntersection<StylesFromTool<T[number]>>;

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
    // deno-lint-ignore no-explicit-any
    TImports extends ClientToolsClass<any, any, any>[] = [],
  >(
    sourceFileUrl: string | URL,
    options: ClientToolsOptions<TFunctions, TStyles, TImports>,
  ): ClientToolsClass<
    TFunctions & UnionOfFunctions<TImports>,
    TStyles & UnionOfStyles<TImports>,
    Empty
  >;
}

interface HandlersConstructor {
  new <TFunctions extends Record<string, AnyFunction>>(
    sourceFileUrl: string | URL,
    factory: HandlerFactory<TFunctions>,
  ): ClientToolsClass<TFunctions, Record<never, never>, Record<never, never>>;
  // Overloads without sourceFileUrl (functions as first arg)
  new <TFunctions extends Record<string, AnyFunction> = Empty>(
    functions: TFunctions,
  ): ClientToolsClass<TFunctions, Empty, Empty>;

  new <
    TFunctions extends Record<string, AnyFunction> = Empty,
    TImports extends AnyClientToolsInstance[] = [],
  >(
    options: HandlersOptions<TImports>,
    functions: TFunctions,
  ): ClientToolsClass<
    TFunctions & UnionOfFunctions<TImports>,
    UnionOfStyles<TImports>,
    Empty
  >;

  // Overloads with sourceFileUrl
  new <TFunctions extends Record<string, AnyFunction> = Empty>(
    sourceFileUrl: string | URL | undefined,
    functions: TFunctions,
  ): ClientToolsClass<TFunctions, Empty, Empty>;

  new <
    TFunctions extends Record<string, AnyFunction> = Empty,
    TImports extends AnyClientToolsInstance[] = [],
  >(
    sourceFileUrl: string | URL | undefined,
    options: HandlersOptions<TImports>,
    functions: TFunctions,
  ): ClientToolsClass<
    TFunctions & UnionOfFunctions<TImports>,
    UnionOfStyles<TImports>,
    Empty
  >;
}

interface StoreConstructor extends HandlersConstructor {
  new <TStored extends object, TFunctions extends Record<string, AnyFunction>>(
    sourceFileUrl: string | URL,
    factory: (stored: TStored) => TFunctions | Promise<TFunctions>,
  ): ClientToolsClass<TFunctions, Record<never, never>, Record<never, never>>;
}

interface SignalsConstructor {
  new <Definitions extends SignalDefinitions>(
    sourceFileUrl: string | URL,
    factory: (tools: SignalTools) => Definitions,
  ): ClientToolsClass<SignalAccessors<Definitions>, Empty, Empty> & {
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
     * Runs the factory on the server with `inputs` written to its writable
     * signals and returns every signal's value, so initial markup can be
     * rendered by the same computations the browser runs. Each call builds a
     * fresh graph; nothing is shared between calls.
     */
    evaluateUsingInitialValues(
      inputs?: SignalInputs<Definitions>,
    ): SignalValues<Definitions>;
  };
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
 * const routeHandlers = new tiny.Handlers(import.meta.url, {
 *   handleClick(e: MouseEvent) {
 *     console.log("Clicked", e);
 *   },
 * });
 *
 * const routeStyles = new tiny.Styles(import.meta.url, { buttonStyle });
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
  private static readonly RESERVED_FUNCTION_KEYS = new Set<string>([
    "multiHandler",
    "multiHandlerSync",
    "run",
  ]);
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
  /** Track which style names were defined directly (not imported) */
  private _ownStyleNames = new Set<string>();
  /** Previous bundle filename derived from cached constituent style hashes. */
  private _staleOwnBundleFilename?: string;
  /** Whether the on-disk reconciliation prune has run yet for this instance. */
  private _stalePruneDone = false;
  /** Tracks which imported ClientTools instance owns each imported style name */
  private _importedStyleOwners = new Map<string, AnyClientToolsInstance>();
  /** Tracks imported ClientTools instances for cascading ensureBuilt() */
  // deno-lint-ignore no-explicit-any
  private _importedTools: ClientToolsClass<any, any, any>[] = [];
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

  protected get stateful(): boolean {
    return false;
  }

  /** Module-level code emitted ahead of this instance's handlers. */
  protected get bundlePrelude(): string {
    return "";
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
    const caller = context?.active ? context.owner : undefined;
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
    factory: (
      stored: Record<string, unknown>,
    ) => ReturnType<HandlerFactory<Record<string, AnyFunction>>>,
  ): void {
    let storedBinding = "stored";
    if (this.stateful) {
      const source = factory.toString().trim();
      const parameter = source.match(
        /^(?:async\s+)?(?:function(?:\s+[$\w]+)?\s*|[$\w]+\s*)?\(\s*([$A-Z_a-z][$\w]*)?\s*\)/,
      ) ?? source.match(/^(?:async\s+)?([$A-Z_a-z][$\w]*)\s*=>/);
      if (!parameter) {
        throw new TypeError(
          "Store factory must have no parameters or one simple state parameter.",
        );
      }
      storedBinding = parameter[1] ?? storedBinding;
      if (storedBinding === "fn" || storedBinding === "_handler") {
        throw new TypeError(
          "Store state parameter cannot be named fn or _handler.",
        );
      }
    }
    this._definitionReady = false;
    this._definitionInitializer = async (scope) => {
      const functions = await factory(Object.create(null));
      if (
        !functions || typeof functions !== "object" ||
        Object.values(functions).some((value) => typeof value !== "function")
      ) {
        throw new TypeError(
          "Handlers factory must return an object of handler functions.",
        );
      }
      this._processFunctions(functions, scope.dependencies, storedBinding);
      await this._bundle?.pruneDependencies();
      this._refreshHandlerFilenames();
    };
  }

  private _refreshHandlerFilenames(): void {
    for (const [name, instance] of this._clientFunctions) {
      this.handlerFilenames.set(name, instance.filename);
      (this as Record<string, unknown>)[name] = instance.expression;
    }
  }

  constructor(
    sourceFileUrl: string | URL | undefined,
    // deno-lint-ignore no-explicit-any
    options?: ClientToolsOptions<any, any, any>,
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

    const processOptions = () => {
      if (options) {
        // Process imports first so imported functions/styles are available
        if (options.imports) {
          for (const externalTools of options.imports) {
            this._processImport(externalTools);
          }
        }

        // Process functions
        if (options.functions) {
          this._processFunctions(options.functions);
        }

        // Process styles
        if (options.styles) {
          this._processStyles(options.styles);
        }
      }
    };
    if (
      options?.imports?.some((tools: AnyClientToolsInstance) =>
        !tools._definitionReady
      )
    ) {
      this._definitionReady = false;
      this._definitionInitializer = async () => {
        await Promise.all(
          options.imports.map((tools: AnyClientToolsInstance) =>
            tools.ensureDefined()
          ),
        );
        processOptions();
        this._finalizeStyleBundle();
      };
    } else {
      processOptions();
    }

    // After all styles are processed, bundle scoped styles into one file
    this._finalizeStyleBundle();
  }

  /** Internal helper to process function definitions */
  private _processFunctions<T extends Record<string, AnyFunction>>(
    fns: T,
    dependencies?: ReadonlyMap<string, ClientFunctionImpl>,
    storedBinding = "stored",
  ): void {
    const registry = getImportRegistry(this.sourceFileUrl);
    for (const [fnName, fn] of Object.entries(fns)) {
      if (ClientToolsClass.RESERVED_FUNCTION_KEYS.has(fnName)) {
        throw new Error(
          `Cannot define function '${fnName}': this key is reserved by fn API.`,
        );
      }

      // Check for duplicate from imports
      if (this._clientFunctions.has(fnName)) {
        throw new Error(
          `Cannot define function '${fnName}': ` +
            `a function with this name already exists (imported from another ClientTools instance)`,
        );
      }

      this._bundle ??= new HandlerBundle({
        sourceFileUrl: this.sourceFileUrl,
        index: this._bundleIndex,
        stateful: this.stateful,
        storedBinding,
        dependencies,
        prelude: this.bundlePrelude,
      });
      const instance = this._bundle.add(fnName, fn);
      registry.set(fnName, instance);
      this._clientFunctions.set(fnName, instance);
    }
    this._refreshHandlerFilenames();
  }

  /**
   * After all own scoped styles are collected, compute a bundle filename
   * from the sorted individual filenames and register the bundle.
   * Only styles defined directly on this instance are bundled — imported
   * styles retain their original bundle filename from the exporting instance.
   */
  private _finalizeStyleBundle(): void {
    if (this._ownStyleNames.size === 0) return;

    // Only bundle styles that belong to this instance (not imported)
    const ownStyles = [...this._scopedStyles.entries()]
      .filter(([name]) => this._ownStyleNames.has(name));

    if (ownStyles.length === 0) return;

    const sortedStyleHashes = ownStyles
      .map(([, s]) => getFilenameHashFragment(s.filename))
      .sort();
    const sortedCleanupStyleHashes = ownStyles
      .map(([, s]) => getFilenameHashFragment(s.cleanupFilenameForCurrentBuild))
      .sort();

    // Use source filename as prefix for readability
    const urlPath = this.sourceFileUrl.replace(/\\/g, "/");
    const baseName = urlPath.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      "styles";
    const bundleFilename = `${baseName}_${
      generateStyleHash(sortedStyleHashes.join(","))
    }`;
    const staleBundleFilename = `${baseName}_${
      generateStyleHash(sortedCleanupStyleHashes.join(","))
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
   * Recompute bundle filenames and imported style asset mappings after any
   * constituent style filename changes.
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

    for (const [styleName, owner] of this._importedStyleOwners) {
      const importedFilename = owner._styleFilenames.get(styleName);
      const importedStyle = this._scopedStyles.get(styleName);
      if (importedFilename) {
        this.styleFilenames.set(styleName, importedFilename);
      } else if (importedStyle) {
        this.styleFilenames.set(styleName, importedStyle.filename);
      }
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

    // Ensure imported tools are built first (their bundles need to exist)
    await Promise.all(this._importedTools.map((t) => t.ensureBuilt()));

    // Write every bundle these handlers live in (own + imported), along
    // with everything those bundles import.
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

    // Revalidate all scoped styles (own + imported)
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

    // Update styleFilenames for any imported styles whose filename changed
    if (anyStyleChanged) {
      this.refreshStyleAssetMappings();
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
    const urlPath = this.sourceFileUrl.replace(/\\/g, "/");
    const baseName = urlPath.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      "styles";
    const prefix = `${baseName}_`;
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

  /** Internal helper to process imports from another ClientTools instance */
  // deno-lint-ignore no-explicit-any
  private _processImport<T extends ClientToolsClass<any, any, any>>(
    externalTools: T,
  ): void {
    this._importedTools.push(externalTools);
    const externalSourceUrl = externalTools.sourceFileUrl;

    // Import functions
    for (const [fnName, instance] of externalTools._handlerDefinitions) {
      if (ClientToolsClass.RESERVED_FUNCTION_KEYS.has(fnName)) {
        throw new Error(
          `Cannot import ClientFunction '${fnName}' from '${externalSourceUrl}': this key is reserved by fn API.`,
        );
      }

      if (this._clientFunctions.has(fnName)) {
        throw new Error(
          `Cannot import ClientFunction '${fnName}' from '${externalSourceUrl}': ` +
            `a function with this name already exists in the factory (from '${this.sourceFileUrl}')`,
        );
      }

      getImportRegistry(this.sourceFileUrl).set(fnName, instance);
      (this as Record<string, unknown>)[fnName] = instance.expression;
      this.handlerFilenames.set(fnName, instance.filename);
      this._clientFunctions.set(fnName, instance);
    }

    // Import styles — use the external tools' bundle filenames so accessing
    // an imported style references the original bundle, not this instance's.
    const externalStyleFilenames = externalTools._styleFilenames;
    for (const [styleName, instance] of externalTools._styles) {
      if (ClientToolsClass.RESERVED_STYLED_KEYS.has(styleName)) {
        throw new Error(
          `Cannot import style '${styleName}' from '${externalSourceUrl}': this key is reserved by styled API.`,
        );
      }

      if (!this._scopedStyles.has(styleName)) {
        (this as Record<string, unknown>)[styleName] = instance;
        // Use the external bundle filename (not the individual style filename)
        this.styleFilenames.set(
          styleName,
          externalStyleFilenames.get(styleName) ?? instance.filename,
        );
        this._importedStyleOwners.set(styleName, externalTools);
        this._scopedStyles.set(styleName, instance);
        // Note: NOT added to _ownStyleNames — imported styles are excluded from this bundle
      }
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
  constructor(
    sourceFileUrlOrOptionsOrFunctions:
      | string
      | URL
      | undefined
      // deno-lint-ignore no-explicit-any
      | HandlersOptions<any>
      | Record<string, AnyFunction>,
    optionsOrFunctions?:
      // deno-lint-ignore no-explicit-any
      | HandlersOptions<any>
      | Record<string, AnyFunction>
      | HandlerFactory<Record<string, AnyFunction>>,
    maybeFunctions?: Record<string, AnyFunction>,
  ) {
    if (typeof optionsOrFunctions === "function") {
      if (
        !(typeof sourceFileUrlOrOptionsOrFunctions === "string" ||
          sourceFileUrlOrOptionsOrFunctions instanceof URL) ||
        !normalizeSourceFileUrl(sourceFileUrlOrOptionsOrFunctions)
      ) {
        throw new TypeError(
          "Handlers factory requires a valid source file URL. Pass import.meta.url.",
        );
      }
      if (maybeFunctions !== undefined) {
        throw new TypeError(
          "Handlers factory does not accept a third argument.",
        );
      }
      super(sourceFileUrlOrOptionsOrFunctions);
      this.defineFactory(optionsOrFunctions);
      return;
    }
    // Detect whether first arg is the sourceFileUrl (string/URL/undefined) or
    // already an object (options or functions, meaning no sourceFileUrl was
    // provided).
    const firstArgIsObject = sourceFileUrlOrOptionsOrFunctions !== null &&
      sourceFileUrlOrOptionsOrFunctions !== undefined &&
      typeof sourceFileUrlOrOptionsOrFunctions === "object" &&
      !(sourceFileUrlOrOptionsOrFunctions instanceof URL);

    let sourceFileUrl: string | URL | undefined;
    // deno-lint-ignore no-explicit-any
    let options: HandlersOptions<any> | undefined;
    let functions: Record<string, AnyFunction>;

    if (firstArgIsObject) {
      // No sourceFileUrl: either `(functions)` or `(options, functions)`
      sourceFileUrl = undefined;
      if (optionsOrFunctions === undefined) {
        functions = sourceFileUrlOrOptionsOrFunctions as Record<
          string,
          AnyFunction
        >;
      } else {
        // deno-lint-ignore no-explicit-any
        options = sourceFileUrlOrOptionsOrFunctions as HandlersOptions<any>;
        functions = optionsOrFunctions as Record<string, AnyFunction>;
      }
    } else {
      sourceFileUrl = sourceFileUrlOrOptionsOrFunctions as
        | string
        | URL
        | undefined;
      if (maybeFunctions === undefined) {
        // `(url, functions)`
        functions = (optionsOrFunctions ?? {}) as Record<string, AnyFunction>;
      } else {
        // `(url, options, functions)`
        // deno-lint-ignore no-explicit-any
        options = optionsOrFunctions as HandlersOptions<any>;
        functions = maybeFunctions;
      }
    }

    const resolvedUrl = normalizeSourceFileUrl(sourceFileUrl);
    if (!resolvedUrl && !cache.trustCache) {
      const detail = sourceFileUrl
        ? `Received ${
          JSON.stringify(String(sourceFileUrl))
        } which is not a valid file path. ` +
          "Did you mean to use import.meta.url instead of import.meta.main?"
        : "No source file URL was provided.";
      console.warn(
        `[tiny-tools] \x1b[33mWarning:\x1b[0m tiny.Handlers constructed without a valid source file URL. ${detail} ` +
          "Handler changes will not be tracked between builds and stale files will not be cleaned up. " +
          "Pass import.meta.url as the first argument to enable change tracking.",
      );
    }

    super(sourceFileUrl, {
      functions,
      imports: options?.imports,
    });
  }
}

class StoreClass extends HandlersClass {
  protected override get stateful(): boolean {
    return true;
  }
}

type SignalFactory = (tools: SignalTools) => SignalDefinitions;

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

/** `signalClasses` also returns the per-instance handle class, for validation. */
type InternalSignalTools = SignalTools & {
  // deno-lint-ignore no-explicit-any
  InstanceSignal: new (...args: any[]) => { readonly initialValue: unknown };
};

/** Runs the factory server-side (values inert) to validate it and list its signals. */
function signalNames(factory: SignalFactory): string[] {
  const tools = signalClasses(false) as InternalSignalTools;
  const definitions = factory(tools);
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
  return Object.keys(definitions);
}

/**
 * One bundle per instance: the prelude runs the factory once against the
 * shared signal runtime (signals.ts), and each signal is exported as an
 * accessor that can be referenced like any handler.
 */
class SignalsClass extends StoreClass {
  #prelude: { code: string };
  #factory: SignalFactory;

  /** The one browser module holding the signal classes, shared by every collection. */
  static #runtime: InstanceType<typeof HandlersClass> | undefined;

  static get runtime(): InstanceType<typeof HandlersClass> {
    return SignalsClass.#runtime ??= new Handlers(
      new URL("./signals.ts", import.meta.url),
      { signalClasses },
    );
  }

  constructor(sourceFileUrl: string | URL, factory: SignalFactory) {
    const prelude = { code: "" };
    const owner: { collection?: SignalsClass } = {};
    super(sourceFileUrl, async () => {
      const names = signalNames(factory);
      await imports(SignalsClass.runtime);
      // Module-level names in the bundle must not collide with signal exports.
      const taken = new Set([
        ...names,
        "fn",
        "signal",
        "stored",
        "signalClasses",
      ]);
      const free = (base: string) => {
        let name = base;
        for (let index = 2; taken.has(name); index++) name = `${base}${index}`;
        taken.add(name);
        return name;
      };
      // Unpack the toolkit with the factory's own parameter and run its body
      // once, e.g. `const { Signal } = fn.signalClasses();` followed by
      // `const signals = (() => {...})();`. Factories of other shapes are
      // called with the toolkit instead.
      const tools = `fn.signalClasses(true, ${
        JSON.stringify(owner.collection!.instanceKey)
      })`;
      const split = splitFactory(factory.toString());
      const parameterNames = split?.parameter.match(/[$A-Z_a-z][$\w]*/g) ??
        [];
      let graph: string;
      if (split && !parameterNames.some((name) => taken.has(name))) {
        parameterNames.forEach((name) => taken.add(name));
        graph = free("signals");
        prelude.code =
          (split.parameter ? `const ${split.parameter} = ${tools};\n` : "") +
          `const ${graph} = (${split.body})();`;
      } else {
        const define = free("defineSignals");
        graph = free("signals");
        prelude.code = `const ${define} = ${factory};\n` +
          `const ${graph} = ${define}(${tools});`;
      }
      return Object.fromEntries(names.map((name) => {
        const property = /^[$A-Z_a-z][$\w]*$/.test(name)
          ? `.${name}`
          : `[${JSON.stringify(name)}]`;
        return [
          name,
          handlerFromSource(`function (event) {
            return ${graph}${property}.handleEvent(this, event);
          }`),
        ];
      }));
    });
    this.#prelude = prelude;
    owner.collection = this;
    this.#factory = factory;
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

  /** Must match the key `perInstance(name, ...)` builds in signals.ts. */
  instanceKeyFor(name: string): string {
    return `${this.instanceKey}-${name}`;
  }

  evaluateUsingInitialValues(
    inputs: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const tools = signalClasses(true) as InternalSignalTools;
    const graph = this.#factory(tools);
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
    // Per-instance signals report a fresh instance's value; `.all` aggregates
    // see no instances on the server.
    return Object.fromEntries(
      Object.entries(graph).map(([name, signal]) => [
        name,
        signal instanceof tools.InstanceSignal
          ? signal.initialValue
          : (signal as { value: unknown }).value,
      ]),
    );
  }

  protected override get bundlePrelude(): string {
    return this.#prelude.code;
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

    const resolvedUrl = normalizeSourceFileUrl(sourceFileUrl);
    if (!resolvedUrl && !cache.trustCache) {
      const detail = sourceFileUrl
        ? `Received ${
          JSON.stringify(String(sourceFileUrl))
        } which is not a valid file path. ` +
          "Did you mean to use import.meta.url instead of import.meta.main?"
        : "No source file URL was provided.";
      console.warn(
        `[tiny-tools] \x1b[33mWarning:\x1b[0m tiny.Styles constructed without a valid source file URL. ${detail} ` +
          "Style changes will not be tracked between builds and stale CSS files will not be cleaned up. " +
          "Pass import.meta.url as the first argument to enable change tracking.",
      );
    }

    super(sourceFileUrl, { styles });
  }
}

export const Handlers: HandlersConstructor =
  HandlersClass as unknown as HandlersConstructor;

/** @deprecated Use Signals instead. Retained for compatibility. */
export const Store: StoreConstructor =
  StoreClass as unknown as StoreConstructor;

export const Signals: SignalsConstructor =
  SignalsClass as unknown as SignalsConstructor;

export const Styles: StylesConstructor =
  StylesClass as unknown as StylesConstructor;

export async function imports(): Promise<ImportedTools<Empty, Empty>>;
export async function imports<
  const TTools extends [AnyClientToolsInstance, ...AnyClientToolsInstance[]],
>(
  ...tools: TTools
): Promise<
  ImportedTools<
    UnionToIntersection<ExtractFunctions<TTools[number]>>,
    UnionToIntersection<ExtractStyles<TTools[number]>>,
    UnionToIntersection<ExtractSignals<TTools[number]>>
  >
>;
export async function imports(
  ...tools: AnyClientToolsInstance[]
): Promise<ImportedTools<unknown, unknown, unknown>> {
  const definition = handlerDefinitionScope.getStore();
  if (definition?.active) {
    if (tools.length === 0) {
      throw new Error(
        "Handler definitions require explicit tools in tiny.imports().",
      );
    }
    await Promise.all(tools.map((tool) => tool.ensureDefined()));
    const references: Record<string, AnyFunction> = Object.create(null);
    const signalReferences: Record<string, unknown> = Object.create(null);
    for (const tool of tools) {
      for (const [name, instance] of tool._handlerDefinitions) {
        const isSignal = tool instanceof SignalsClass;
        const dependencyName = isSignal ? `signal:${name}` : name;
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
      signal: signalReferences as SignalReferences<unknown>,
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
      get events() {
        return unsupported();
      },
      get handlers() {
        return unsupported();
      },
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
  if (!context && tools.length === 0) {
    throw new Error(
      "tiny.imports() requires at least one TinyTools instance when no Hono request context is active.",
    );
  }
  await Promise.all(tools.map((tool) => tool.ensureBuilt()));
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
  const handlers = new Proxy({}, {
    get: (_target, property) =>
      resolveToolAccessFromChain(
        tools.filter((tool) => !(tool instanceof SignalsClass)),
        "function",
        property,
        recordUsage,
      ),
  });
  const signals = tools.filter((tool) => tool instanceof SignalsClass);
  const styled = new Proxy({}, {
    get: (_target, property) =>
      resolveToolAccessFromChain(tools, "style", property, recordUsage),
  });
  return {
    signal: createSignalReferences((name) =>
      resolveToolAccessFromChain(signals, "function", name, recordUsage)
    ),
    fn: createHandlerReferences((name) =>
      (handlers as Record<string, unknown>)[name]
    ),
    events: createEvents((name) => (handlers as Record<string, unknown>)[name]),
    handlers: handlers as ActivateClientFunctions<unknown>,
    styled: styled as ActivateScopedStyles<unknown>,
    get c(): Context {
      if (!context) {
        throw new Error("tiny.imports() has no active Hono request context.");
      }
      return context;
    },
  };
}

/** Type alias for external use - represents a ClientTools instance */
// deno-lint-ignore no-explicit-any
export type ClientTools<F = any, S = any, G = any> = ClientToolsClass<F, S, G>;

/** Export for use in build process to check if handlers have dependencies that changed */
export { changedHandlerKeys };
