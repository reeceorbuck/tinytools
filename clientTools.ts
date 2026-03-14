/**
 * ClientTools module for @tiny-tools/hono
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
  mergeClassNames,
  normalizeScopedStyleInput,
  SCOPE_BOUNDARY_CLASS,
  ScopedStyleImpl,
  type ScopedStyleInput,
  styleBundleRegistry,
} from "./scopedStyles.ts";
import { tryGetContext } from "hono/context-storage";
import type { Context } from "hono";

// Import shared registries from registry modules
import { changedHandlerKeys, ClientFunctionImpl } from "./clientFunctions.ts";

// ============================================================================
// Cache Management (combined for both functions and styles)
// ============================================================================

type ClientToolsCacheV1 = {
  version: 2;
  hashConfig: {
    handlerHashLength: number;
    styleHashLength: number;
  };
  files: Record<
    string,
    {
      mtimeMs: number;
      /** External imports from other files (via .import()) - stored as "sourceFileUrl::fnName" */
      externalImports: string[];
      /** Handler filenames in this file */
      handlers: Record<string, string>; // fnName -> filename
      /** Style definitions in this file */
      styles: Record<string, string>; // styleName -> filename
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
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const fullHash = Math.abs(hash).toString(16).padStart(8, "0");
  return fullHash.slice(0, getHashLength(kind));
}

export function generateHandlerHash(str: string): string {
  return generateHash(str, "handler");
}

export function generateStyleHash(str: string): string {
  return generateHash(str, "style");
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

  private hashConfig: ClientToolsCacheV1["hashConfig"] = getCurrentHashConfig();

  files: ClientToolsCacheV1["files"] = {};

  constructor() {
    // Load the cache from disk
    try {
      const text = Deno.readTextFileSync(CACHE_PATH);
      const parsed = JSON.parse(text);

      if (
        parsed && parsed.version === 2 && parsed.files &&
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
        };

        generatedHandlerHashLength = loadedHashConfig.handlerHashLength;
        generatedStyleHashLength = loadedHashConfig.styleHashLength;
        this.hashConfig = loadedHashConfig;
        const current = getCurrentHashConfig();

        if (
          loadedHashConfig.handlerHashLength === current.handlerHashLength &&
          loadedHashConfig.styleHashLength === current.styleHashLength
        ) {
          this.files = loaded.files;
        }
      }
    } catch {
      // ignore missing/invalid cache
    }
  }

  /** Clear cached hash-dependent filenames after hash config changes. */
  resetHashDependentState(): void {
    this.files = {};
    this.hashConfig = getCurrentHashConfig();
    this.sourceFileMtimeMemo.clear();
    this.filesWithMtimeChange.clear();
    this.markDirty();
  }

  /** Mark the cache as dirty and schedule a flush to disk */
  markDirty(): void {
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.dirty || this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.dirty) return;
      try {
        Deno.mkdirSync(CACHE_DIR, { recursive: true });
        const data: ClientToolsCacheV1 = {
          version: 2,
          hashConfig: this.hashConfig,
          files: this.files,
        };
        Deno.writeTextFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
        this.dirty = false;
      } catch {
        // ignore write errors
      }
    });
  }

  /** Get the mtime of a source file (memoized) */
  getSourceFileMtimeMs(sourceFileUrl: string): number | null {
    const memo = this.sourceFileMtimeMemo.get(sourceFileUrl);
    if (memo !== undefined) return memo;
    try {
      const stat = Deno.statSync(new URL(sourceFileUrl));
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

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

// ============================================================================
// Type Definitions
// ============================================================================

/** Helper type for extend return - accumulates raw function and style types */
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
  extend<TNextTools extends ClientTools<any, any, any>>(
    tools: TNextTools,
  ): ExtendResult<
    TAccumulatedFunctions & ExtractFunctions<TLocalTools>,
    TAccumulatedStyles & ExtractStyles<TLocalTools>,
    TNextTools
  >;
};

/**
 * Helper type for the activated client tools proxy.
 * Provides access to functions and styles, plus extend() method.
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
   * const { fn, styled } = c.var.tools.extend(singleRouteTools);
   * ```
   */
  // deno-lint-ignore no-explicit-any
  extend<TLocalTools extends ClientToolsClass<any, any, any>>(
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
 * This pattern allows `new ClientTools(url, options)` to properly infer types.
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

/**
 * Unified factory for creating both client functions and scoped styles.
 * All options are passed to the constructor for a cleaner API.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { addTinyTools, extendTools, ClientTools, css } from "@tiny-tools/hono";
 *
 * const buttonStyle = css`
 *   background: blue;
 *   color: white;
 * `;
 *
 * const tools = new ClientTools(import.meta.url, {
 *   functions: {
 *     handleClick(e: MouseEvent) {
 *       console.log("Clicked", e);
 *     },
 *   },
 *   styles: { buttonStyle },
 * });
 *
 * // Create app with middleware
 * const app = new Hono()
 *   .use(...addTinyTools())
 *   .use(extendTools(tools));
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
  /** Stores ScopedStyleImpl instances for global styles (not exposed on styled) */
  private _globalStyles = new Map<string, ScopedStyleImpl>();

  constructor(
    sourceFileUrl: string | URL,
    // deno-lint-ignore no-explicit-any
    options?: ClientToolsOptions<any, any, any, any>,
  ) {
    this.sourceFileUrl = typeof sourceFileUrl === "string"
      ? sourceFileUrl
      : sourceFileUrl.toString();

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
    for (const [fnName, fn] of Object.entries(fns)) {
      // Check for duplicate from imports
      if (this._clientFunctions.has(fnName)) {
        throw new Error(
          `Cannot define function '${fnName}': ` +
            `a function with this name already exists (imported from another ClientTools instance)`,
        );
      }

      const instance = new ClientFunctionImpl(fnName, fn, this.sourceFileUrl);
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

    const sortedFilenames = ownStyles
      .map(([, s]) => s.filename)
      .sort();

    // Use source filename as prefix for readability
    const urlPath = this.sourceFileUrl.replace(/\\/g, "/");
    const baseName = urlPath.split("/").pop()?.replace(/\.[^.]+$/, "") ??
      "styles";
    const bundleFilename = `${baseName}_${
      generateStyleHash(sortedFilenames.join(","))
    }`;

    // Register the bundle
    styleBundleRegistry.set(bundleFilename, ownStyles.map(([, s]) => s));

    // Update only own scoped style entries to point to the bundle filename
    for (const styleName of this._ownStyleNames) {
      this.styleFilenames.set(styleName, bundleFilename);
    }
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
      // Normalize the CSS - remove excess whitespace
      const normalizedCss = cssContent.replace(/\s+/g, " ").trim();

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
   * Get all global styles as an array for use with addGlobalStyles middleware.
   * Returns an array of ScopedStyleImpl instances that were defined with globalStyles.
   *
   * @example
   * ```ts
   * const tools = new ClientTools(import.meta.url, {
   *   globalStyles: { globalStyles: css`body { font-family: sans-serif; }` },
   * });
   *
   * // Pass to middleware:
   * app.use(addGlobalStyles(...tools.globalStyles));
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
    engage: () => EngageResult<
      AccumulatedFunctions & ExtractFunctions<T1>,
      AccumulatedStyles & ExtractStyles<T1>
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
    engage: () => EngageResult<
      AccumulatedFunctions & ExtractFunctions<T1> & ExtractFunctions<T2>,
      AccumulatedStyles & ExtractStyles<T1> & ExtractStyles<T2>
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
    engage: () => EngageResult<
      & AccumulatedFunctions
      & ExtractFunctions<T1>
      & ExtractFunctions<T2>
      & ExtractFunctions<T3>,
      & AccumulatedStyles
      & ExtractStyles<T1>
      & ExtractStyles<T2>
      & ExtractStyles<T3>
    >;
  };
  // deno-lint-ignore no-explicit-any
  extend(...others: ClientToolsClass<any, any, any>[]): {
    engage: () => EngageResult<unknown, unknown>;
  };
  // deno-lint-ignore no-explicit-any
  extend(...others: ClientToolsClass<any, any, any>[]): {
    engage: () => EngageResult<unknown, unknown>;
  } {
    return {
      engage: () => {
        const c = tryGetContext();
        if (!c) {
          return this._engageWithoutContext([...others, this]);
        }
        // deno-lint-ignore no-explicit-any
        let tools = (c as any).var.tools as any;
        // Extend with the additional tools first (ancestors/shared)
        for (const other of others) {
          tools = tools.extend(other);
        }
        // Extend with self (the most-local tools) last
        tools = tools.extend(this);
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
   * @returns The extended tools (`fn`, `styled`, `extend`) plus `c` (the Hono context)
   */
  engage(): EngageResult<AccumulatedFunctions, AccumulatedStyles> {
    const c = tryGetContext();
    if (!c) {
      return this._engageWithoutContext([this]);
    }
    // deno-lint-ignore no-explicit-any
    const tools = (c as any).var.tools.extend(this);
    return { ...tools, c };
  }
}

/**
 * Export ClientTools with the constructor interface for proper type inference.
 * When you write `new ClientTools(url, options)`, TypeScript will infer the types
 * from the options object automatically.
 */
export const ClientTools: ClientToolsConstructor =
  ClientToolsClass as ClientToolsConstructor;

/** Type alias for external use - represents a ClientTools instance */
// deno-lint-ignore no-explicit-any
export type ClientTools<F = any, S = any, G = any> = ClientToolsClass<F, S, G>;

/** Export for use in build process to check if handlers have dependencies that changed */
export { changedHandlerKeys };
