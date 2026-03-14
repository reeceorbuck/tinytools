/**
 * Client Functions Registry module for @tiny-tools/hono
 *
 * Provides shared registries for client-side event handlers.
 * The actual implementation is in clientTools.ts.
 *
 * @module
 */

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

/**
 * Interface for handler implementations stored in the registry.
 * @internal
 */
export interface ClientFunctionEntry {
  fnName: string;
  fn: AnyFunction;
  filename: string;
  sourceFileUrl?: string;
  needsRebuildDueToDependencyChange(): boolean;
  buildCode(): Promise<string>;
}

/** Global registry of all handlers for build process */
export const handlers = new Map<AnyFunction, ClientFunctionEntry>();

/** Import registries by source file URL */
const importsBySourceFileUrl = new Map<string, Map<string, string>>();

/** Get or create the import registry for a source file URL */
export function getImportRegistry(sourceFileUrl?: string): Map<string, string> {
  const key = sourceFileUrl ?? "__global__";
  const existing = importsBySourceFileUrl.get(key);
  if (existing) return existing;
  const created = new Map<string, string>();
  importsBySourceFileUrl.set(key, created);
  return created;
}

/** Reset all import registries - used for testing */
export function resetImportRegistries(): void {
  importsBySourceFileUrl.clear();
}

/** Create a unique key for a handler that includes its source file */
export function handlerKey(sourceFileUrl: string, fnName: string): string {
  return `${sourceFileUrl}::${fnName}`;
}

/** Track handlers whose filenames changed this run - keyed by "sourceFileUrl::fnName" */
export const changedHandlerKeys = new Set<string>();

/** Track which source files had any handler change this run */
export const filesWithChangedHandlers = new Set<string>();

// ============================================================================
// ClientFunctionImpl
// ============================================================================

import { cache, generateHandlerHash } from "./clientTools.ts";

/**
 * Internal implementation of a client function.
 * @internal
 */
export class ClientFunctionImpl<
  T extends AnyFunction = AnyFunction,
  FName extends string = string,
> {
  fnName: FName;
  fn: T;
  filename: string;
  sourceFileUrl?: string;

  constructor(
    fnName: FName,
    fn: T,
    sourceFileUrl?: string,
  ) {
    if (typeof fn !== "function") {
      throw new Error("ClientFunction requires a function");
    }

    let cachedFilename: string | undefined;
    const mtimeChanged = sourceFileUrl
      ? cache.checkAndTrackMtimeChange(sourceFileUrl)
      : false;

    if (sourceFileUrl && !mtimeChanged) {
      cachedFilename = cache.files[sourceFileUrl]?.handlers[fnName];
    }

    let resolvedFilename: string;
    if (cachedFilename) {
      resolvedFilename = cachedFilename;
    } else {
      console.log(
        "Generating filename for ClientFunction by hashing: ",
        fnName,
      );
      const str = fn.toString();
      resolvedFilename = `${fnName}_${generateHandlerHash(str)}`;

      if (sourceFileUrl) {
        const sourceMtimeMs = cache.getSourceFileMtimeMs(sourceFileUrl);
        if (sourceMtimeMs !== null) {
          cache.files[sourceFileUrl] ??= {
            mtimeMs: sourceMtimeMs,
            externalImports: [],
            handlers: {},
            styles: {},
          };
          const oldFilename = cache.files[sourceFileUrl].handlers[fnName];

          if (oldFilename && oldFilename !== resolvedFilename) {
            console.log(
              `Handler ${fnName} filename changed: ${oldFilename} -> ${resolvedFilename}`,
            );
            changedHandlerKeys.add(handlerKey(sourceFileUrl, fnName));
            filesWithChangedHandlers.add(sourceFileUrl);
          }

          cache.files[sourceFileUrl].handlers[fnName] = resolvedFilename;
          cache.markDirty();
        }
      }
    }
    Object.defineProperty(fn, "name", { value: fnName });
    this.fnName = fnName;
    this.fn = fn;
    this.filename = resolvedFilename;
    this.sourceFileUrl = sourceFileUrl;
    // deno-lint-ignore no-explicit-any
    (this as any)[fnName] =
      `handlers.${this.filename}(this, event)` as unknown as T;

    handlers.set(fn, this);
    const registry = getImportRegistry(sourceFileUrl);
    registry.set(fnName, this.filename);
  }

  import(targetSourceFileUrl: string | URL) {
    const targetKey = typeof targetSourceFileUrl === "string"
      ? targetSourceFileUrl
      : targetSourceFileUrl.toString();

    const registry = getImportRegistry(targetKey);
    registry.set(this.fnName, this.filename);

    const fileEntry = cache.files[targetKey];
    if (fileEntry && this.sourceFileUrl) {
      const importKey = handlerKey(this.sourceFileUrl, this.fnName);
      if (!fileEntry.externalImports.includes(importKey)) {
        fileEntry.externalImports.push(importKey);
        cache.markDirty();
      }
    }

    return this;
  }

  needsRebuildDueToDependencyChange(): boolean {
    if (!this.sourceFileUrl) return false;
    if (changedHandlerKeys.size === 0 && filesWithChangedHandlers.size === 0) {
      return false;
    }

    if (filesWithChangedHandlers.has(this.sourceFileUrl)) {
      const fileEntry = cache.files[this.sourceFileUrl];
      if (fileEntry) {
        for (const fnName of Object.keys(fileEntry.handlers)) {
          if (fnName === this.fnName) continue;
          const siblingKey = handlerKey(this.sourceFileUrl, fnName);
          if (changedHandlerKeys.has(siblingKey)) {
            console.log(
              `Handler ${this.fnName} needs rebuild because sibling ${fnName} changed`,
            );
            return true;
          }
        }
      }
    }

    const fileEntry = cache.files[this.sourceFileUrl];
    if (fileEntry && fileEntry.externalImports.length > 0) {
      for (const externalKey of fileEntry.externalImports) {
        if (changedHandlerKeys.has(externalKey)) {
          const fnName = externalKey.split("::")[1] ?? externalKey;
          console.log(
            `Handler ${this.fnName} needs rebuild because external dependency ${fnName} changed`,
          );
          return true;
        }
      }
    }

    return false;
  }

  async buildCode() {
    const { buildHandlerCode } = await import("./build.ts");
    const registry = getImportRegistry(this.sourceFileUrl);
    return buildHandlerCode(this.fnName, this.fn, this.filename, registry);
  }
}
