/**
 * ClientTools module for @tinytools/hono-tools
 *
 * Provides a unified factory for creating both client-side event handlers
 * and scoped CSS styles. Consolidates ClientFunctionFactory and ScopedStyleFactory
 * into a single ergonomic class.
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
  scopedStylesRegistry,
  styleBundleRegistry,
} from "./scopedStyles.ts";
import { tryGetContext } from "hono/context-storage";
import type { Context } from "hono";

// Import shared registries from registry modules
import { changedHandlerKeys, ClientFunctionImpl } from "./clientFunctions.ts";

// ============================================================================
// Cache Management (combined for both functions and styles)
// ============================================================================

/**
 * Bump this when the hash algorithm changes to auto-invalidate caches.
 * History: 1 = Java-style 32-bit, 2 = FNV-1a 64-bit
 */
const HASH_ALGORITHM_VERSION = 2;

type ClientToolsCacheV1 = {
  version: 3;
  hashConfig: {
    handlerHashLength: number;
    styleHashLength: number;
    hashAlgorithm?: number;
  };
  files: Record<
    string,
    {
      mtimeMs: number;
      /** External imports from other files (via .import()) - stored as "sourceFileUrl::fnName" */
      externalImports: string[];
      /** Handler filenames in this file - ordered by instantiation */
      handlers: Record<string, string[]>; // fnName -> [filename, ...] (ordered by instantiation)
      /** Style definitions in this file - ordered by instantiation */
      styles: Record<string, string[]>; // styleName -> [filename, ...] (ordered by instantiation)
    }
  >;
};

const CACHE_DIR = "./.cache";
const CACHE_PATH = `${CACHE_DIR}/clientToolsCache.json`;

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

function getCurrentHashConfig(): ClientToolsCacheV1["hashConfig"] {
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

export function generateHash(
  str: string,
  kind: "handler" | "style" = "style",
): string {
  const input = new TextEncoder().encode(str);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (const byte of input) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  const fullHash = hash.toString(16).padStart(16, "0");
  return fullHash.slice(0, getHashLength(kind));
}

export function generateHandlerHash(str: string): string {
  return generateHash(str, "handler");
}

export function generateStyleHash(str: string): string {
  return generateHash(str, "style");
}

/** Base URL for the current working directory, used to produce portable relative paths */
const CWD_URL = new URL(`file:///${Deno.cwd().replace(/\\/g, "/")}/`);

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

  /** Tracks instantiation order per file per name per kind (handler/style) */
  private nameOccurrences = new Map<string, number>();

  private hashConfig: ClientToolsCacheV1["hashConfig"] = getCurrentHashConfig();

  /** When true, skip all file stat checks and trust cached filenames.
   *  This is the default. Pass --lazy to disable. */
  readonly trustCache: boolean;

  files: ClientToolsCacheV1["files"] = {};

  constructor() {
    const lazyMode = Deno.args.includes("--lazy");
    this.trustCache = !lazyMode;

    // Load the cache from disk
    try {
      const text = Deno.readTextFileSync(CACHE_PATH);
      const parsed = JSON.parse(text);

      if (
        parsed && parsed.version === 3 && parsed.files &&
        typeof parsed.files === "object" && parsed.hashConfig
      ) {
        const loaded = parsed as ClientToolsCacheV1;
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
          this.normalizeLoadedFiles();
        }
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
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

  /** Normalize v2 cache entries where handlers/styles were plain strings into string[] */
  private normalizeLoadedFiles(): void {
    for (const fileEntry of Object.values(this.files)) {
      for (const [name, value] of Object.entries(fileEntry.handlers)) {
        if (typeof value === "string") {
          (fileEntry.handlers as Record<string, string | string[]>)[name] = [
            value,
          ];
        }
      }
      for (const [name, value] of Object.entries(fileEntry.styles)) {
        if (typeof value === "string") {
          (fileEntry.styles as Record<string, string | string[]>)[name] = [
            value,
          ];
        }
      }
    }
  }

  /** Clear cached hash-dependent filenames after hash config changes. */
  resetHashDependentState(): void {
    this.files = {};
    this.hashConfig = getCurrentHashConfig();
    this.sourceFileMtimeMemo.clear();
    this.filesWithMtimeChange.clear();
    this.nameOccurrences.clear();
    this.markDirty();
  }

  /** Start a fresh mtime-tracking pass for a build/request cycle. */
  beginChangeDetectionPass(): void {
    this.sourceFileMtimeMemo.clear();
    this.filesWithMtimeChange.clear();
  }

  /**
   * Get the next occurrence index for a name in a file.
   * Each call increments the counter, so call exactly once per ClientTools instance per name.
   */
  getNextOccurrenceIndex(
    sourceFileUrl: string,
    name: string,
    kind: "handler" | "style",
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
    if (this.trustCache) return;
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
    try {
      Deno.mkdirSync(CACHE_DIR, { recursive: true });
      const data: ClientToolsCacheV1 = {
        version: 3,
        hashConfig: this.hashConfig,
        files: this.files,
      };
      // Atomic write: write to temp file then rename, so a watcher restart
      // mid-write can't corrupt the cache.
      const tmp = `${CACHE_PATH}.tmp`;
      Deno.writeTextFileSync(tmp, JSON.stringify(data, null, 2));
      Deno.renameSync(tmp, CACHE_PATH);
      this.dirty = false;
    } catch (e) {
      console.warn("[tiny-tools] failed to write cache:", e);
    }
  }

  /** Get the mtime of a source file (memoized) */
  getSourceFileMtimeMs(sourceFileUrl: string): number | null {
    if (this.trustCache) {
      return this.files[sourceFileUrl]?.mtimeMs ?? null;
    }
    const memo = this.sourceFileMtimeMemo.get(sourceFileUrl);
    if (memo !== undefined) return memo;
    try {
      // Resolve relative paths (produced by normalizeSourceFileUrl) back to
      // absolute file:// URLs so Deno.statSync can find them.
      const url = sourceFileUrl.startsWith("file://")
        ? new URL(sourceFileUrl)
        : new URL(sourceFileUrl, CWD_URL);
      const stat = Deno.statSync(url);
      const value = stat.mtime ? stat.mtime.getTime() : null;
      this.sourceFileMtimeMemo.set(sourceFileUrl, value);
      return value;
    } catch {
      this.sourceFileMtimeMemo.set(sourceFileUrl, null);
      return null;
    }
  }

  /** Check if file mtime changed and track it (only first caller updates cache) */
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
      // New file - create entry and mark as changed
      this.files[sourceFileUrl] = {
        mtimeMs: sourceMtimeMs,
        externalImports: [],
        handlers: {},
        styles: {},
      };
      this.markDirty();
      this.filesWithMtimeChange.add(sourceFileUrl);
      return true;
    }

    if (existingEntry.mtimeMs !== sourceMtimeMs) {
      // mtime changed - update cache and track
      existingEntry.mtimeMs = sourceMtimeMs;
      this.markDirty();
      this.filesWithMtimeChange.add(sourceFileUrl);
      return true;
    }

    return false;
  }
}

/** Shared cache instance for all client tools */
export const cache = new ClientToolsCacheManager();

export const registeredClientTools = new Set<ClientToolsClass<any, any, any>>();

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

// ============================================================================
// Type Definitions
// ============================================================================

/** Helper type for extendWithImports return - accumulates raw function and style types */
type ExtendResult<
  TAccumulatedFunctions,
  TAccumulatedStyles,
  // deno-lint-ignore no-explicit-any
  TLocalTools extends ClientTools<any, any, any>,
> = {
  fn: ActivateClientFunctions<
    TAccumulatedFunctions & ExtractFunctions<TLocalTools>
  >;
  styled: ActivateScopedStyles<
    TAccumulatedStyles & ExtractStyles<TLocalTools>
  >;
  // deno-lint-ignore no-explicit-any
  extendWithImports<TNextTools extends ClientTools<any, any, any>>(
    tools: TNextTools,
  ): ExtendResult<
    TAccumulatedFunctions & ExtractFunctions<TLocalTools>,
    TAccumulatedStyles & ExtractStyles<TLocalTools>,
    TNextTools
  >;
};

/**
 * Helper type for the activated client tools proxy.
 * Provides access to functions and styles, plus extendWithImports() method.
 */
export interface ActivatedClientTools<TFunctions, TStyles> {
  /**
   * Access to activated client functions.
   */
  fn: ActivateClientFunctions<TFunctions>;
  /**
   * Access to activated scoped styles.
   */
  styled: ActivateScopedStyles<TStyles>;
  /**
   * Extend with component-local tools inside a route handler.
   * Uses `this` type to properly infer the current tools, preserving all types
   * from ancestor middleware.
   *
   * @example
   * ```tsx
   * const { fn, styled } = await c.var.tools.extendWithImports(singleRouteTools);
   * ```
   */
  // deno-lint-ignore no-explicit-any
  extendWithImports<TLocalTools extends ClientToolsClass<any, any, any>>(
    localTools: TLocalTools,
  ): ExtendResult<
    TFunctions,
    TStyles,
    TLocalTools
  >;
}

/** Extract functions type from a ClientTools instance */
// deno-lint-ignore no-explicit-any
type ExtractFunctions<T> = T extends ClientToolsClass<infer F, any, any> ? F
  // deno-lint-ignore ban-types
  : {};

/** Extract styles type from a ClientTools instance (excludes global styles) */
// deno-lint-ignore no-explicit-any
type ExtractStyles<T> = T extends ClientToolsClass<any, infer S, any> ? S
  // deno-lint-ignore ban-types
  : {};

type ReservedStyledKey = "mergeClasses";

type ForbidReservedStyledKeys<T extends Record<string, ScopedStyleInput>> =
  & T
  & {
    [K in Extract<keyof T, ReservedStyledKey>]?: never;
  };

/** Result type for the engage() method on ClientTools */
type EngageResult<TFunctions, TStyles> = {
  readonly fn: ActivateClientFunctions<TFunctions>;
  readonly styled: ActivateScopedStyles<TStyles>;
  readonly c: Context;
};

// deno-lint-ignore no-explicit-any
type AnyClientToolsInstance = ClientToolsClass<any, any, any>;

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
  // deno-lint-ignore ban-types
  TFunctions extends Record<string, AnyFunction> = {},
  // deno-lint-ignore ban-types
  TStyles extends Record<string, ScopedStyleInput> = {},
  // deno-lint-ignore ban-types
  TGlobalStyles extends Record<string, ScopedStyleInput> = {},
  // deno-lint-ignore no-explicit-any
  TImports extends ClientToolsClass<any, any, any>[] = [],
> {
  /** Client functions to define */
  functions?: TFunctions;
  /** Scoped styles to define */
  styles?: ForbidReservedStyledKeys<TStyles>;
  /** Global styles to define (not wrapped in @scope) */
  globalStyles?: TGlobalStyles;
  /** Other ClientTools instances to import functions and styles from */
  imports?: TImports;
}

export interface HandlersOptions<
  // deno-lint-ignore no-explicit-any
  TImports extends AnyClientToolsInstance[] = [],
> {
  /** Other TinyTools instances to import functions and styles from */
  imports?: TImports;
}

export interface StylesOptions<
  // deno-lint-ignore no-explicit-any
  TImports extends AnyClientToolsInstance[] = [],
> {
  /** Mark all defined styles as global styles */
  global?: boolean;
  /** Other TinyTools instances to import functions and styles from */
  imports?: TImports;
}

/** Infer result type for ClientToolsOptions */
export type InferClientToolsOptions<T> = T extends ClientToolsOptions<
  infer TFunctions,
  infer TStyles,
  infer TGlobalStyles,
  infer TImports
>
  // deno-lint-ignore no-explicit-any
  ? TImports extends ClientToolsClass<any, any, any>[] ? ClientToolsClass<
      TFunctions & UnionOfFunctions<TImports>,
      TStyles & UnionOfStyles<TImports>,
      TGlobalStyles
    >
  : ClientToolsClass<TFunctions, TStyles, TGlobalStyles>
  : never;

/** Helper to extract union of functions from an array of ClientTools (works with both tuples and arrays) */
// deno-lint-ignore no-explicit-any
type UnionOfFunctions<T extends ClientToolsClass<any, any, any>[]> =
  T[number] extends ClientToolsClass<infer F, unknown, unknown> ? F
    : Record<PropertyKey, never>;

/** Helper to extract union of styles from an array of ClientTools (works with both tuples and arrays) */
// deno-lint-ignore no-explicit-any
type UnionOfStyles<T extends ClientToolsClass<any, any, any>[]> =
  T[number] extends ClientToolsClass<unknown, infer S, unknown> ? S
    : Record<PropertyKey, never>;

/**
 * Constructor interface for ClientTools that enables type inference from options.
 * @internal Used only by Handlers and Styles constructors.
 */
interface ClientToolsConstructor {
  /** Create an empty ClientTools instance */
  // deno-lint-ignore ban-types
  new (sourceFileUrl: string | URL): ClientToolsClass<{}, {}, {}>;

  /** Create a ClientTools instance with options - types are inferred from the options */
  new <
    // deno-lint-ignore ban-types
    TFunctions extends Record<string, AnyFunction> = {},
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
    // deno-lint-ignore ban-types
    TGlobalStyles extends Record<string, ScopedStyleInput> = {},
    // deno-lint-ignore no-explicit-any
    TImports extends ClientToolsClass<any, any, any>[] = [],
  >(
    sourceFileUrl: string | URL,
    options: ClientToolsOptions<TFunctions, TStyles, TGlobalStyles, TImports>,
  ): ClientToolsClass<
    TFunctions & UnionOfFunctions<TImports>,
    TStyles & UnionOfStyles<TImports>,
    TGlobalStyles
  >;
}

interface HandlersConstructor {
  // deno-lint-ignore ban-types
  new <TFunctions extends Record<string, AnyFunction> = {}>(
    sourceFileUrl: string | URL,
    functions: TFunctions,
  ): ClientToolsClass<TFunctions, {}, {}>;

  new <
    // deno-lint-ignore ban-types
    TFunctions extends Record<string, AnyFunction> = {},
    // deno-lint-ignore no-explicit-any
    TImports extends AnyClientToolsInstance[] = [],
  >(
    sourceFileUrl: string | URL,
    functions: TFunctions,
    options: HandlersOptions<TImports>,
  ): ClientToolsClass<
    TFunctions & UnionOfFunctions<TImports>,
    UnionOfStyles<TImports>,
    {}
  >;
}

interface StylesConstructor {
  // Overloads without sourceFileUrl (styles as first arg)
  new <
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
  >(
    styles: ForbidReservedStyledKeys<TStyles>,
  ): ClientToolsClass<{}, TStyles, {}>;

  new <
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
    // deno-lint-ignore no-explicit-any
    TImports extends AnyClientToolsInstance[] = [],
  >(
    styles: ForbidReservedStyledKeys<TStyles>,
    options: { global: true; imports?: TImports },
  ): ClientToolsClass<
    UnionOfFunctions<TImports>,
    UnionOfStyles<TImports>,
    TStyles
  >;

  new <
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
    // deno-lint-ignore no-explicit-any
    TImports extends AnyClientToolsInstance[] = [],
  >(
    styles: ForbidReservedStyledKeys<TStyles>,
    options: StylesOptions<TImports>,
  ): ClientToolsClass<
    UnionOfFunctions<TImports>,
    TStyles & UnionOfStyles<TImports>,
    {}
  >;

  // Overloads with sourceFileUrl
  new <
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
  >(
    sourceFileUrl: string | URL | undefined,
    styles: ForbidReservedStyledKeys<TStyles>,
  ): ClientToolsClass<{}, TStyles, {}>;

  new <
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
    // deno-lint-ignore no-explicit-any
    TImports extends AnyClientToolsInstance[] = [],
  >(
    sourceFileUrl: string | URL | undefined,
    styles: ForbidReservedStyledKeys<TStyles>,
    options: { global: true; imports?: TImports },
  ): ClientToolsClass<
    UnionOfFunctions<TImports>,
    UnionOfStyles<TImports>,
    TStyles
  >;

  new <
    // deno-lint-ignore ban-types
    TStyles extends Record<string, ScopedStyleInput> = {},
    // deno-lint-ignore no-explicit-any
    TImports extends AnyClientToolsInstance[] = [],
  >(
    sourceFileUrl: string | URL | undefined,
    styles: ForbidReservedStyledKeys<TStyles>,
    options: StylesOptions<TImports>,
  ): ClientToolsClass<
    UnionOfFunctions<TImports>,
    TStyles & UnionOfStyles<TImports>,
    {}
  >;
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
 *   .use(...tiny.middleware.core())
 *   .use(tiny.middleware.sharedImports(routeHandlers, routeStyles));
 *
 * // In route handlers
 * app.get("/", (c) => {
 *   const { fn, styled } = c.var.tools;
 *   return c.render(
 *     <button class={styled.buttonStyle} onClick={fn.handleClick}>
 *       Click me
 *     </button>
 *   );
 * });
 * ```
 */
class ClientToolsClass<
  // deno-lint-ignore ban-types
  AccumulatedFunctions = {},
  // deno-lint-ignore ban-types
  AccumulatedStyles = {},
  // deno-lint-ignore ban-types
  AccumulatedGlobalStyles = {},
> {
  private static readonly RESERVED_STYLED_KEYS = new Set<string>([
    "mergeClasses",
  ]);

  private sourceFileUrl: string;
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
  /** Tracks which imported ClientTools instance owns each imported style name */
  // deno-lint-ignore no-explicit-any
  private _importedStyleOwners = new Map<
    string,
    ClientToolsClass<any, any, any>
  >();
  /** Stores ScopedStyleImpl instances for global styles (not exposed on styled) */
  private _globalStyles = new Map<string, ScopedStyleImpl>();
  /** Tracks imported ClientTools instances for cascading ensureBuilt() */
  // deno-lint-ignore no-explicit-any
  private _importedTools: ClientToolsClass<any, any, any>[] = [];
  /** Whether ensureBuilt() has already run */
  private _ensureBuiltPromise: Promise<void> | null = null;

  constructor(
    sourceFileUrl: string | URL | undefined,
    // deno-lint-ignore no-explicit-any
    options?: ClientToolsOptions<any, any, any, any>,
  ) {
    this.sourceFileUrl = normalizeSourceFileUrl(sourceFileUrl) ??
      (typeof sourceFileUrl === "string"
        ? sourceFileUrl
        : sourceFileUrl?.toString() ?? "");
    registeredClientTools.add(this);

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
        this._processStyles(options.styles, false);
      }

      // Process global styles
      if (options.globalStyles) {
        this._processStyles(options.globalStyles, true);
      }
    }

    // After all styles are processed, bundle scoped styles into one file
    this._finalizeStyleBundle();
  }

  /** Internal helper to process function definitions */
  private _processFunctions<T extends Record<string, AnyFunction>>(
    fns: T,
  ): void {
    // Compute a stable fingerprint of imported function names so that
    // adding/removing imports produces a different handler hash (and filename),
    // which busts the browser cache.
    const importsFingerprint = [...this._clientFunctions.keys()].sort().join(
      ",",
    );

    for (const [fnName, fn] of Object.entries(fns)) {
      // Check for duplicate from imports
      if (this._clientFunctions.has(fnName)) {
        throw new Error(
          `Cannot define function '${fnName}': ` +
            `a function with this name already exists (imported from another ClientTools instance)`,
        );
      }

      const instance = new ClientFunctionImpl(
        fnName,
        fn,
        this.sourceFileUrl,
        importsFingerprint,
      );
      // deno-lint-ignore no-explicit-any
      (this as any)[fnName] = (instance as any)[fnName];
      this.handlerFilenames.set(fnName, instance.filename);
      this._clientFunctions.set(fnName, instance);
    }
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
    const baseName = urlPath.split("/").pop()?.replace(/\.[^.]+$/, "") ??
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
   * Called at request time by tiny.middleware.sharedImports(). Skips entirely in prod mode.
   * Subsequent calls return the same promise (idempotent).
   */
  async ensureBuilt(): Promise<void> {
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
    const handlerDir = "./public/handlers";
    const stylesDir = "./public/styles";

    cache.beginChangeDetectionPass();

    // Ensure imported tools are built first (their bundles need to exist)
    await Promise.all(this._importedTools.map((t) => t.ensureBuilt()));

    // Revalidate all handlers (own + imported)
    for (const [fnName, impl] of this._clientFunctions) {
      const rebuilt = await impl.revalidateAndBuild(handlerDir);
      if (rebuilt || impl.filename !== this.handlerFilenames.get(fnName)) {
        // Update our filename map if the handler's filename changed
        this.handlerFilenames.set(fnName, impl.filename);
        // deno-lint-ignore no-explicit-any
        (this as any)[fnName] = (impl as any)[impl.fnName];
      }
    }

    // Capture old filenames before revalidation so we can clean up stale files
    const oldGlobalStyleFilenames = new Map<string, string>();
    for (const [name, impl] of this._globalStyles) {
      oldGlobalStyleFilenames.set(name, impl.filename);
    }

    // Revalidate all scoped styles (own + imported)
    let anyStyleChanged = false;
    for (const [styleName, impl] of this._scopedStyles) {
      const changed = impl.revalidate();
      if (changed) {
        anyStyleChanged = true;
      }
    }

    // Revalidate global styles too
    for (const [, impl] of this._globalStyles) {
      const changed = impl.revalidate();
      if (changed) {
        anyStyleChanged = true;
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
        await Deno.remove(`${stylesDir}/${oldBundleFilename}.css`).catch(
          () => {},
        );
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
          await Deno.remove(`${stylesDir}/${this._staleOwnBundleFilename}.css`)
            .catch(() => {});
          this._staleOwnBundleFilename = undefined;
        }

        for (const [, style] of ownStyles) {
          style.markCurrentFilenameAsClean();
        }
      }
    }

    // Build individual global style files
    for (const [name, impl] of this._globalStyles) {
      const oldFilename = oldGlobalStyleFilenames.get(name);
      await this._ensureStyleFileBuilt(stylesDir, impl);
      // If revalidate changed the filename, the old file on disk is stale
      if (oldFilename && oldFilename !== impl.filename) {
        await Deno.remove(`${stylesDir}/${oldFilename}.css`).catch(
          () => {},
        );
      }
      const staleFilename = impl.staleFilenameForCleanup;
      if (staleFilename && staleFilename !== impl.filename) {
        await Deno.remove(`${stylesDir}/${staleFilename}.css`).catch(
          () => {},
        );
      }
      impl.markCurrentFilenameAsClean();
    }
  }

  private async _ensureStyleBundleBuilt(
    stylesDir: string,
    bundleFilename: string,
    styles: ScopedStyleImpl[],
  ): Promise<void> {
    const filePath = `${stylesDir}/${bundleFilename}.css`;
    const fileExists = await Deno.stat(filePath).then(() => true).catch(
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
    await Deno.mkdir(stylesDir, { recursive: true });
    const cssContent = buildLayeredCssContent(styles);
    await Deno.writeTextFile(filePath, cssContent);
    console.log(
      `Style bundle written: ${filePath} (${styles.length} styles)`,
    );
  }

  private async _ensureStyleFileBuilt(
    stylesDir: string,
    style: ScopedStyleImpl,
  ): Promise<void> {
    const filePath = `${stylesDir}/${style.filename}.css`;
    const fileExists = await Deno.stat(filePath).then(() => true).catch(
      () => false,
    );

    if (fileExists) {
      const styleKey = style.sourceFileUrl
        ? `${style.sourceFileUrl}::${style.styleName}`
        : "";
      if (!styleKey || !changedStyleKeys.has(styleKey)) return;
    }

    await Deno.mkdir(stylesDir, { recursive: true });
    const cssContent = style.buildCssContent();
    await Deno.writeTextFile(filePath, cssContent);
    console.log(`Style file written: ${filePath}`);
  }

  /** Internal helper to process style definitions */
  private _processStyles<T extends Record<string, ScopedStyleInput | string>>(
    styles: T,
    isGlobal: boolean,
  ): void {
    for (const [styleName, styleInput] of Object.entries(styles)) {
      if (
        !isGlobal &&
        ClientToolsClass.RESERVED_STYLED_KEYS.has(styleName)
      ) {
        throw new Error(
          `Cannot define style '${styleName}': this key is reserved by styled API.`,
        );
      }

      const { cssContent, scope, layer } = normalizeScopedStyleInput(
        styleInput,
      );
      const normalizedCss = normalizeCssWhitespace(cssContent);

      const instance = new ScopedStyleImpl(
        styleName,
        normalizedCss,
        this.sourceFileUrl,
        isGlobal,
        scope,
        layer,
      );

      if (isGlobal) {
        this.styleFilenames.set(styleName, instance.filename);
        this._globalStyles.set(styleName, instance);
      } else {
        (this as Record<string, unknown>)[styleName] = instance;
        this.styleFilenames.set(styleName, instance.filename);
        this._scopedStyles.set(styleName, instance);
        this._ownStyleNames.add(styleName);
      }
    }
  }

  /** Internal helper to process imports from another ClientTools instance */
  // deno-lint-ignore no-explicit-any
  private _processImport<T extends ClientToolsClass<any, any, any>>(
    externalTools: T,
  ): void {
    this._importedTools.push(externalTools);
    // deno-lint-ignore no-explicit-any
    const externalClientFunctions = (externalTools as any)
      ._clientFunctions as Map<string, ClientFunctionImpl>;
    // deno-lint-ignore no-explicit-any
    const externalSourceUrl = (externalTools as any).sourceFileUrl as string;

    // Import functions
    for (const [fnName, instance] of externalClientFunctions) {
      if (this._clientFunctions.has(fnName)) {
        throw new Error(
          `Cannot import ClientFunction '${fnName}' from '${externalSourceUrl}': ` +
            `a function with this name already exists in the factory (from '${this.sourceFileUrl}')`,
        );
      }

      instance.import(this.sourceFileUrl);
      // deno-lint-ignore no-explicit-any
      (this as any)[fnName] = (externalTools as any)[fnName];
      this.handlerFilenames.set(fnName, instance.filename);
      this._clientFunctions.set(fnName, instance);
    }

    // Import styles — use the external tools' bundle filenames so accessing
    // an imported style references the original bundle, not this instance's.
    // deno-lint-ignore no-explicit-any
    const externalScopedStyles = (externalTools as any)
      ._scopedStyles as Map<string, ScopedStyleImpl>;
    // deno-lint-ignore no-explicit-any
    const externalStyleFilenames = (externalTools as any)
      .styleFilenames as Map<string, string>;
    for (const [styleName, instance] of externalScopedStyles) {
      if (ClientToolsClass.RESERVED_STYLED_KEYS.has(styleName)) {
        throw new Error(
          `Cannot import style '${styleName}' from '${externalSourceUrl}': this key is reserved by styled API.`,
        );
      }

      if (!this._scopedStyles.has(styleName)) {
        // deno-lint-ignore no-explicit-any
        (this as any)[styleName] = instance;
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
    return this.handlerFilenames;
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

  /**
   * Get raw references to registered client functions for module-level composition.
   * Use these references when one client function needs to call another (especially
   * imported handlers) during `functions` declaration.
   *
   * Why this is required:
   * - `fn.*` handlers are request-activated proxies and only exist in render/context flow.
   * - Client function definitions run at module setup time, before any request context exists.
   * - Grabbing references here lets you safely call another registered client function inside
   *   a client function body.
   */
  get getFunctionReferences(): AccumulatedFunctions {
    const result = {} as AccumulatedFunctions;
    for (const fnName of this._clientFunctions.keys()) {
      // deno-lint-ignore no-explicit-any
      (result as any)[fnName] = (this as any)[fnName];
    }
    return result;
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

  /**
   * Get all global styles as an array for use with tiny.middleware.globalStyles().
   * Returns an array of ScopedStyleImpl instances that were defined with globalStyles.
   *
   * @example
   * ```ts
   * const globalTools = new tiny.Styles(import.meta.url, {
   *   globalStyles: css`body { font-family: sans-serif; }`,
   * }, { global: true });
   *
   * // Pass to middleware:
   * app.use(tiny.middleware.globalStyles(...globalTools.globalStyles));
   * ```
   */
  get globalStyles(): ScopedStyleImpl[] {
    return Array.from(this._globalStyles.values());
  }

  // deno-lint-ignore no-explicit-any
  private _engageWithoutContext(toolsChain: ClientToolsClass<any, any, any>[]) {
    const fn = new Proxy({}, {
      get: (_target, prop) =>
        resolveToolAccessFromChain(
          toolsChain,
          "function",
          prop,
          recordNoContextUsage,
        ),
    });

    const styled = new Proxy({}, {
      get: (_target, prop) =>
        resolveToolAccessFromChain(
          toolsChain,
          "style",
          prop,
          recordNoContextUsage,
        ),
    });

    return {
      // deno-lint-ignore no-explicit-any
      fn: fn as any,
      // deno-lint-ignore no-explicit-any
      styled: styled as any,
      get c(): Context {
        throw new Error(
          "ClientTools.engage() was used without an active Hono request context. Use only fn/styled in this path.",
        );
      },
    };
  }

  /**
   * Extend this ClientTools instance with additional tools, returning a chainable
   * object with an `engage()` method. The most-local tools should call extend.
   *
   * @example
   * ```ts
   * const { fn, styled } = componentTools.extend(globalTools, autoSubmitTools).engage();
   * ```
   *
   * @returns An object with an `engage()` method that merges all tools
   */
  // deno-lint-ignore no-explicit-any
  extend<T1 extends ClientToolsClass<any, any, any>>(
    t1: T1,
  ): {
    engage: () => Promise<
      EngageResult<
        AccumulatedFunctions & ExtractFunctions<T1>,
        AccumulatedStyles & ExtractStyles<T1>
      >
    >;
  };
  extend<
    // deno-lint-ignore no-explicit-any
    T1 extends ClientToolsClass<any, any, any>,
    // deno-lint-ignore no-explicit-any
    T2 extends ClientToolsClass<any, any, any>,
  >(
    t1: T1,
    t2: T2,
  ): {
    engage: () => Promise<
      EngageResult<
        AccumulatedFunctions & ExtractFunctions<T1> & ExtractFunctions<T2>,
        AccumulatedStyles & ExtractStyles<T1> & ExtractStyles<T2>
      >
    >;
  };
  extend<
    // deno-lint-ignore no-explicit-any
    T1 extends ClientToolsClass<any, any, any>,
    // deno-lint-ignore no-explicit-any
    T2 extends ClientToolsClass<any, any, any>,
    // deno-lint-ignore no-explicit-any
    T3 extends ClientToolsClass<any, any, any>,
  >(
    t1: T1,
    t2: T2,
    t3: T3,
  ): {
    engage: () => Promise<
      EngageResult<
        & AccumulatedFunctions
        & ExtractFunctions<T1>
        & ExtractFunctions<T2>
        & ExtractFunctions<T3>,
        & AccumulatedStyles
        & ExtractStyles<T1>
        & ExtractStyles<T2>
        & ExtractStyles<T3>
      >
    >;
  };
  // deno-lint-ignore no-explicit-any
  extend(...others: ClientToolsClass<any, any, any>[]): {
    engage: () => Promise<EngageResult<unknown, unknown>>;
  };
  // deno-lint-ignore no-explicit-any
  extend(...others: ClientToolsClass<any, any, any>[]): {
    engage: () => Promise<EngageResult<unknown, unknown>>;
  } {
    return {
      engage: async () => {
        await Promise.all([this, ...others].map((t) => t.ensureBuilt()));
        const c = tryGetContext();
        if (!c) {
          return this._engageWithoutContext([...others, this]);
        }
        // deno-lint-ignore no-explicit-any
        let tools = (c as any).var.tools as any;
        // Extend with the additional tools first (ancestors/shared)
        for (const other of others) {
          tools = await tools.extendWithImports(other);
        }
        // Extend with self (the most-local tools) last
        tools = await tools.extendWithImports(this);
        return { ...tools, c };
      },
    };
  }

  /**
   * Shorthand for getting the current request context and extending tools with this instance.
   *
   * @example
   * ```ts
   * const { fn, styled, c } = componentTools.engage();
   * ```
   *
   * @returns The extended tools (`fn`, `styled`, `extendWithImports`) plus `c` (the Hono context)
   */
  async engage(): Promise<
    EngageResult<AccumulatedFunctions, AccumulatedStyles>
  > {
    await this.ensureBuilt();
    const c = tryGetContext();
    if (!c) {
      return this._engageWithoutContext([this]);
    }
    // deno-lint-ignore no-explicit-any
    const tools = await (c as any).var.tools.extendWithImports(this);
    return { ...tools, c };
  }
}

/**
 * @internal Base class constructor — use `Handlers` or `Styles` instead.
 */
export const ClientTools: ClientToolsConstructor =
  ClientToolsClass as ClientToolsConstructor;

class HandlersClass extends ClientToolsClass<{}, {}, {}> {
  constructor(
    sourceFileUrl: string | URL,
    functions: Record<string, AnyFunction>,
    // deno-lint-ignore no-explicit-any
    options?: HandlersOptions<any>,
  ) {
    super(sourceFileUrl, {
      functions,
      imports: options?.imports,
    });
  }
}

class StylesClass extends ClientToolsClass<{}, {}, {}> {
  constructor(
    sourceFileUrlOrStyles:
      | string
      | URL
      | undefined
      | Record<string, ScopedStyleInput>,
    // deno-lint-ignore no-explicit-any
    stylesOrOptions?: Record<string, ScopedStyleInput> | StylesOptions<any>,
    // deno-lint-ignore no-explicit-any
    maybeOptions?: StylesOptions<any>,
  ) {
    // Detect whether first arg is the styles object (no sourceFileUrl provided)
    const firstArgIsStyles = sourceFileUrlOrStyles !== null &&
      sourceFileUrlOrStyles !== undefined &&
      typeof sourceFileUrlOrStyles === "object" &&
      !(sourceFileUrlOrStyles instanceof URL);

    const sourceFileUrl = firstArgIsStyles
      ? undefined
      : sourceFileUrlOrStyles as string | URL | undefined;
    const styles =
      (firstArgIsStyles ? sourceFileUrlOrStyles : stylesOrOptions) as Record<
        string,
        ScopedStyleInput
      >;
    // deno-lint-ignore no-explicit-any
    const options = (firstArgIsStyles ? stylesOrOptions : maybeOptions) as
      | StylesOptions<any>
      | undefined;

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

    super(
      sourceFileUrl,
      options?.global
        ? { globalStyles: styles, imports: options.imports }
        : { styles, imports: options?.imports },
    );
  }
}

export const Handlers: HandlersConstructor =
  HandlersClass as unknown as HandlersConstructor;

export const Styles: StylesConstructor =
  StylesClass as unknown as StylesConstructor;

export async function imports(): Promise<EngageResult<{}, {}>>;
export async function imports<
  const TTools extends [AnyClientToolsInstance, ...AnyClientToolsInstance[]],
>(
  ...tools: TTools
): Promise<
  EngageResult<
    UnionToIntersection<ExtractFunctions<TTools[number]>>,
    UnionToIntersection<ExtractStyles<TTools[number]>>
  >
>;
export async function imports(
  ...tools: AnyClientToolsInstance[]
): Promise<EngageResult<unknown, unknown>> {
  if (tools.length === 0) {
    const c = tryGetContext();
    if (!c) {
      throw new Error(
        "tiny.imports() requires at least one TinyTools instance when no Hono request context is active.",
      );
    }
    return { ...(c as any).var.tools, c };
  }

  const [localTools, ...ancestorTools] = tools.slice().reverse();
  if (ancestorTools.length === 0) {
    return await localTools.engage();
  }

  return await localTools.extend(...ancestorTools).engage();
}

/** Type alias for external use - represents a ClientTools instance */
// deno-lint-ignore no-explicit-any
export type ClientTools<F = any, S = any, G = any> = ClientToolsClass<F, S, G>;

/** Export for use in build process to check if handlers have dependencies that changed */
export { changedHandlerKeys };
