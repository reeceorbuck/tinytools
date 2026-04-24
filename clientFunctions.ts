/**
 * Client Functions Registry module for @tinytools/hono-tools
 *
 * Provides shared registries for client-side event handlers.
 * The actual implementation is in clientTools.ts.
 *
 * @module
 */

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

import { mkdir, rm, stat as fsStat, writeFile } from "node:fs/promises";

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
  revalidateAndBuild(handlerDir: string): Promise<boolean>;
}

/** Global registry of all handlers for build process */
export const handlers = new Map<AnyFunction, ClientFunctionEntry>();

/** Import registries by source file URL */
const importsBySourceFileUrl = new Map<string, Map<string, string>>();

/** Get or create the import registry for a source file URL */
export function getImportRegistry(sourceFileUrl?: string): Map<string, string> {
  const key = normalizeSourceFileUrl(sourceFileUrl) ?? "__global__";
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
  return `${normalizeSourceFileUrl(sourceFileUrl) ?? sourceFileUrl}::${fnName}`;
}

/** Track handlers whose filenames changed this run - keyed by "sourceFileUrl::fnName" */
export const changedHandlerKeys = new Set<string>();

/** Track which source files had any handler change this run */
export const filesWithChangedHandlers = new Set<string>();

// ============================================================================
// ClientFunctionImpl
// ============================================================================

import {
  cache,
  generateHandlerHash,
  normalizeSourceFileUrl,
} from "./clientTools.ts";

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
  private occurrenceIndex: number;
  private importsFingerprint: string;

  private _computeHashInput(): string {
    const base = this.fn.toString() + "::" + (this.sourceFileUrl ?? "");
    return this.importsFingerprint
      ? `${base}::imports[${this.importsFingerprint}]`
      : base;
  }

  constructor(
    fnName: FName,
    fn: T,
    sourceFileUrl?: string,
    importsFingerprint = "",
  ) {
    if (typeof fn !== "function") {
      throw new Error("ClientFunction requires a function");
    }

    const normalizedSourceFileUrl = normalizeSourceFileUrl(sourceFileUrl);

    // Get the occurrence index for this name in this file (0 for first, 1 for second, etc.)
    const occurrenceIndex = normalizedSourceFileUrl
      ? cache.getNextOccurrenceIndex(normalizedSourceFileUrl, fnName, "handler")
      : 0;

    let cachedFilename: string | undefined;
    if (normalizedSourceFileUrl) {
      cachedFilename = cache.getCachedHandler(
        normalizedSourceFileUrl,
        fnName,
        occurrenceIndex,
      );
    }

    let resolvedFilename: string;
    if (cachedFilename) {
      resolvedFilename = cachedFilename;
    } else {
      console.log(
        "Generating filename for ClientFunction by hashing: ",
        fnName,
      );
      resolvedFilename = `${fnName}_${
        generateHandlerHash(
          fn.toString() + "::" + (normalizedSourceFileUrl ?? "") +
            (importsFingerprint ? `::imports[${importsFingerprint}]` : ""),
        )
      }`;
    }

    if (normalizedSourceFileUrl) {
      cache.files[normalizedSourceFileUrl] ??= {
        mtimeMs: 0,
        externalImports: [],
        handlers: {},
        styles: {},
      };

      cache.setCachedHandler(
        normalizedSourceFileUrl,
        fnName,
        occurrenceIndex,
        resolvedFilename,
      );
      cache.registerHandlerForSource(normalizedSourceFileUrl, this);
    }
    Object.defineProperty(fn, "name", { value: fnName });
    this.fnName = fnName;
    this.fn = fn;
    this.filename = resolvedFilename;
    this.sourceFileUrl = normalizedSourceFileUrl;
    this.occurrenceIndex = occurrenceIndex;
    this.importsFingerprint = importsFingerprint;
    // deno-lint-ignore no-explicit-any
    (this as any)[fnName] =
      `handlers.${this.filename}.call(this, event)` as unknown as T;

    handlers.set(fn, this);
    const registry = getImportRegistry(sourceFileUrl);
    registry.set(fnName, this.filename);
  }

  import(targetSourceFileUrl: string | URL) {
    const targetKey = normalizeSourceFileUrl(targetSourceFileUrl) ??
      (typeof targetSourceFileUrl === "string"
        ? targetSourceFileUrl
        : targetSourceFileUrl.toString());

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

  /**
   * Deferred validation and build. Called at request time via
   * `ensureBuilt()`. If the source file's mtime has changed, re-hashes
   * the handler (renaming the on-disk `.js` if the content hash shifted)
   * and writes a fresh `.js`. Also eagerly revalidates every sibling
   * handler and scoped/global style registered against the same source
   * file — ensuring the entire file's build artifacts are consistent
   * before the source mtime is committed to the cache, even when
   * siblings live in different `ClientTools` instances that the current
   * request never engages.
   *
   * Safe against infinite recursion: a per-pass processed set short
   * circuits sibling calls that have already been handled in this
   * request cycle.
   *
   * Returns true if this handler's `.js` file was (re)written.
   */
  async revalidateAndBuild(handlerDir: string): Promise<boolean> {
    if (!this.sourceFileUrl) return false;
    if (cache.isHandlerProcessedThisPass(this)) return false;
    cache.markHandlerProcessedThisPass(this);

    const mtimeChanged = cache.checkAndTrackMtimeChange(this.sourceFileUrl);
    const rebuilt = await this._revalidateSelf(handlerDir, mtimeChanged);

    // Eagerly revalidate every sibling artifact registered against the
    // same source file. This guarantees the on-disk state for the whole
    // file is consistent before `_doEnsureBuilt` commits the source
    // mtime, even though siblings may belong to `ClientTools` instances
    // the current request never engages directly.
    if (mtimeChanged) {
      await revalidateSourceFileSiblings(this.sourceFileUrl, handlerDir);
    }

    return rebuilt;
  }

  /**
   * Inner revalidate step for just this handler — split out so the
   * eager sibling pass in `revalidateAndBuild` can reuse it without
   * retriggering its own sibling iteration.
   */
  private async _revalidateSelf(
    handlerDir: string,
    mtimeChanged: boolean,
  ): Promise<boolean> {
    if (!this.sourceFileUrl) return false;

    if (mtimeChanged) {
      // Re-hash and check if filename actually changed
      const str = this._computeHashInput();
      const newFilename = `${this.fnName}_${generateHandlerHash(str)}`;

      if (newFilename !== this.filename) {
        const oldFilename = this.filename;
        this.filename = newFilename;
        // deno-lint-ignore no-explicit-any
        (this as any)[this.fnName] =
          `handlers.${this.filename}.call(this, event)` as unknown;

        // Update registries
        const registry = getImportRegistry(this.sourceFileUrl);
        registry.set(this.fnName, this.filename);

        // Update cache
        cache.setCachedHandler(
          this.sourceFileUrl,
          this.fnName,
          this.occurrenceIndex,
          this.filename,
        );

        // Track the change for dependency rebuilds
        changedHandlerKeys.add(handlerKey(this.sourceFileUrl, this.fnName));
        filesWithChangedHandlers.add(this.sourceFileUrl);

        console.log(
          `Handler ${this.fnName} filename changed: ${oldFilename} -> ${this.filename}`,
        );

        // Remove the old handler file from disk
        await rm(`${handlerDir}/${oldFilename}.js`).catch(() => {});
      } else {
        // Filename unchanged, but still ensure the cache entry exists
        // (it may have been cleared by resetHashDependentState)
        cache.setCachedHandler(
          this.sourceFileUrl,
          this.fnName,
          this.occurrenceIndex,
          this.filename,
        );
      }
    }

    try {
      await fsStat(`${handlerDir}/${this.filename}.js`);
      if (!mtimeChanged && !this.needsRebuildDueToDependencyChange()) {
        return false;
      }
    } catch {
      // File doesn't exist, need to build
    }

    const functionCode = await this.buildCode();
    await mkdir(handlerDir, { recursive: true });
    await writeFile(`${handlerDir}/${this.filename}.js`, functionCode);
    console.log(`Handler file written: ${handlerDir}/${this.filename}.js`);
    return true;
  }
}

/**
 * Revalidate every handler and style registered against `sourceFileUrl`
 * that has not yet been processed in the current detection pass. Used
 * by both `ClientFunctionImpl.revalidateAndBuild` and
 * `ScopedStyleImpl.revalidate` to guarantee that a single mtime change
 * on a source file fans out to every build artifact it owns, regardless
 * of which `ClientTools` instance the current request engaged.
 *
 * The per-pass processed sets on the cache manager (reset by
 * `beginChangeDetectionPass`) ensure each artifact is touched at most
 * once per pass and that mutual recursion between handlers and styles
 * terminates.
 */
export async function revalidateSourceFileSiblings(
  sourceFileUrl: string,
  handlerDir: string,
): Promise<void> {
  const siblingHandlers = cache.getHandlersForSource(sourceFileUrl);
  for (const sibling of siblingHandlers) {
    const impl = sibling as ClientFunctionImpl;
    if (cache.isHandlerProcessedThisPass(impl)) continue;
    // revalidateAndBuild itself guards against reentry, so calling it
    // here is safe even though it in turn triggers another sibling
    // pass (which will short-circuit via the processed sets).
    await impl.revalidateAndBuild(handlerDir);
  }

  const { revalidateScopedStyleSibling } = await import("./scopedStyles.ts");
  const siblingStyles = cache.getStylesForSource(sourceFileUrl);
  for (const sibling of siblingStyles) {
    if (cache.isStyleProcessedThisPass(sibling as object)) continue;
    await revalidateScopedStyleSibling(sibling);
  }
}
