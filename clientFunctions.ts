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
  /**
   * Records the previous filename when `_resolveFilename` performs an
   * in-memory rename so the orphaned `.js` on disk can be deleted at
   * the next opportunity. `_revalidateSelf` consumes and clears this.
   * Stored only for the FIRST rename across a pass so multi-step
   * renames (fixed-point loop) still produce a single cleanup.
   */
  private _pendingOldFilename: string | undefined;

  private _computeHashInput(): string {
    const base = this.fn.toString() + "::" + (this.sourceFileUrl ?? "");
    const fingerprint = this._currentImportsFingerprint();
    return fingerprint ? `${base}::imports[${fingerprint}]` : base;
  }

  /**
   * Extract every identifier-looking token in the handler body. Used
   * to scope the imports fingerprint and the emitted import lines to
   * the symbols this handler actually references. False positives
   * (matches inside strings or comments) are acceptable — they only
   * over-include in the fingerprint without affecting correctness or
   * convergence. The own function name is excluded so self-references
   * never count.
   *
   * Cached per-instance because `fn.toString()` is stable for the
   * lifetime of the instance.
   */
  private _cachedReferencedNames: Set<string> | undefined;
  private _referencedNames(): Set<string> {
    if (this._cachedReferencedNames) return this._cachedReferencedNames;
    const out = new Set<string>();
    const src = this.fn.toString();
    const idRe = /[A-Za-z_$][\w$]*/g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(src)) !== null) {
      if (m[0] !== this.fnName) out.add(m[0]);
    }
    this._cachedReferencedNames = out;
    return out;
  }

  /**
   * Build the imports fingerprint from the current filenames of any
   * OTHER handlers this handler's emitted file references. Includes:
   *   - in-file SIBLING handlers (registered against the same source
   *     file) whose names appear in this handler's body.
   *   - cross-file handlers imported via `import()` whose names appear
   *     in this handler's body.
   *
   * Scoping to actually-referenced symbols is essential for in-file
   * sibling groups: emitting every sibling into the fingerprint would
   * create a cyclic feedback loop (each rename perturbs every other
   * sibling's hash) that never converges to a stable filename.
   *
   * Falls back to the static `importsFingerprint` set at construction
   * time when nothing relevant is registered yet.
   *
   * Including referenced filenames in the fingerprint makes this
   * handler's own hash (and therefore filename) change whenever any
   * handler it actually uses is rebuilt with a new content hash —
   * busting browser cache for stale consumer bundles that referenced
   * the old import filename.
   */
  private _currentImportsFingerprint(): string {
    if (!this.sourceFileUrl) return this.importsFingerprint;

    const referenced = this._referencedNames();

    const parts: string[] = [];
    const seen = new Set<string>();

    // In-file siblings + already-wired cross-file imports.
    const registry = getImportRegistry(this.sourceFileUrl);
    for (const [name, filename] of registry.entries()) {
      if (name === this.fnName) continue;
      if (!referenced.has(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      parts.push(`${name}=${filename}`);
    }

    // Cross-file imports recorded in the cache (catches the cold-start
    // case where `import()` has not yet wired the consumer registry).
    const fileEntry = cache.files[this.sourceFileUrl];
    if (fileEntry && fileEntry.externalImports.length > 0) {
      for (const externalKey of fileEntry.externalImports) {
        const sep = externalKey.indexOf("::");
        if (sep === -1) continue;
        const importedSourceFileUrl = externalKey.slice(0, sep);
        const importedFnName = externalKey.slice(sep + 2);
        if (seen.has(importedFnName)) continue;
        if (!referenced.has(importedFnName)) continue;
        const importedHandlers = cache.getHandlersForSource(
          importedSourceFileUrl,
        );
        for (const handler of importedHandlers) {
          const impl = handler as ClientFunctionImpl;
          if (impl.fnName === importedFnName) {
            seen.add(importedFnName);
            parts.push(`${importedFnName}=${impl.filename}`);
            break;
          }
        }
      }
    }

    if (parts.length === 0) return this.importsFingerprint;
    parts.sort();
    return parts.join(",");
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

    if (this.sourceFileUrl) {
      // Ensure the consumer's cache entry exists. `_processImport` calls
      // this method during `super()` BEFORE the consumer's own
      // `_processFunctions` runs (which is what otherwise creates the
      // entry), so without this initialization the externalImports push
      // below is silently dropped on first build.
      cache.files[targetKey] ??= {
        mtimeMs: 0,
        externalImports: [],
        handlers: {},
        styles: {},
      };
      const fileEntry = cache.files[targetKey];
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
   * Pure in-memory rename: recompute the canonical hash (body + source
   * + current imports fingerprint) and, if it differs from the current
   * filename, rename this handler and propagate the change to the
   * import registry, the cache manager and the changed-handler trackers.
   *
   * Performs NO file IO. The orphaned old filename (if any) is recorded
   * in `_pendingOldFilename` for the caller (`_revalidateSelf`) to
   * clean up at write time.
   *
   * Returns true if a rename happened.
   *
   * Safe to call repeatedly in a fixed-point loop \u2014 once the hash is
   * stable the call is a no-op.
   */
  _resolveFilename(): boolean {
    if (!this.sourceFileUrl) return false;
    const str = this._computeHashInput();
    const newFilename = `${this.fnName}_${generateHandlerHash(str)}`;
    if (newFilename === this.filename) return false;

    const oldFilename = this.filename;
    this.filename = newFilename;
    // deno-lint-ignore no-explicit-any
    (this as any)[this.fnName] =
      `handlers.${this.filename}.call(this, event)` as unknown;

    const registry = getImportRegistry(this.sourceFileUrl);
    registry.set(this.fnName, this.filename);

    cache.setCachedHandler(
      this.sourceFileUrl,
      this.fnName,
      this.occurrenceIndex,
      this.filename,
    );

    changedHandlerKeys.add(handlerKey(this.sourceFileUrl, this.fnName));
    filesWithChangedHandlers.add(this.sourceFileUrl);

    // Preserve the FIRST observed old filename across a sequence of
    // fixed-point renames so the eventual cleanup deletes the truly
    // orphaned bundle, not an intermediate rename target that no `.js`
    // file ever existed under.
    if (this._pendingOldFilename === undefined) {
      this._pendingOldFilename = oldFilename;
    }

    console.log(
      `Handler ${this.fnName} filename changed: ${oldFilename} -> ${this.filename}`,
    );

    return true;
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

    // Revalidate any handlers imported from other source files first, so
    // that filename changes in those imports are recorded in
    // `changedHandlerKeys` before this handler decides whether it needs
    // a rebuild. Without this, editing only the imported file (e.g.
    // helpers.tsx) without touching the consumer file would leave the
    // consumer pointing at a stale imported handler filename.
    await revalidateExternalImports(this.sourceFileUrl, handlerDir);

    const mtimeChanged = cache.checkAndTrackMtimeChange(this.sourceFileUrl);

    // When this source file's mtime changed, every handler registered
    // against it potentially needs a rename — and because in-file
    // siblings reference each other through the import registry, the
    // dep-aware hash of any one sibling depends on the resolved
    // filenames of all the others. Run a fixed-point rename pass over
    // the whole group BEFORE computing this handler's own hash so the
    // imports fingerprint reads stable, settled sibling filenames. If
    // we skipped this, a body change in one sibling would update the
    // consumer sibling's emitted file content (to reference the new
    // import) but leave the consumer's own filename hash unchanged,
    // letting the browser keep serving the cached stale bundle.
    if (mtimeChanged) {
      resolveSourceFileSiblingFilenames(this.sourceFileUrl);
    }

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

    // Even when this file's own mtime is unchanged, an imported handler's
    // filename may have changed this pass — in which case our hash input
    // (which now includes imported filenames) has shifted and we need to
    // rename ourselves so consumers/browsers don't keep using a stale
    // cached bundle.
    const depsChanged = !mtimeChanged &&
      this.needsRebuildDueToDependencyChange();

    if (mtimeChanged || depsChanged) {
      // The fixed-point sibling pre-pass in `revalidateAndBuild` may
      // have already renamed us. `_resolveFilename` is a no-op when the
      // hash is already stable, so this call just handles the case
      // where we were entered via the dep-only branch (mtime unchanged,
      // depsChanged true) and the pre-pass therefore did not run.
      this._resolveFilename();

      // If a rename happened (here OR earlier in the pre-pass) the old
      // on-disk file is now orphaned — remove it before writing the
      // fresh one under the new filename.
      if (this._pendingOldFilename) {
        await rm(`${handlerDir}/${this._pendingOldFilename}.js`)
          .catch(() => {});
        this._pendingOldFilename = undefined;
      } else if (mtimeChanged) {
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
      if (!mtimeChanged && !depsChanged) {
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
 * Settle the canonical filename for every handler registered against
 * `sourceFileUrl` via a fixed-point loop. Each iteration calls
 * `_resolveFilename` on every sibling; when none rename in a full
 * iteration the group has converged.
 *
 * Required because in-file siblings reference each other through the
 * shared import registry, so the dep-aware hash of any sibling depends
 * on the resolved filenames of every other sibling. Running this BEFORE
 * a handler's `_revalidateSelf` writes its file guarantees that the
 * imports fingerprint (and therefore the final filename hash) is
 * computed against settled sibling filenames — otherwise a body change
 * in one sibling would propagate into another sibling's emitted file
 * content but fail to bust that sibling's filename hash, leaving the
 * browser cache stuck on a stale bundle.
 *
 * Pure in-memory work; no file IO. Each rename strictly shifts the
 * sibling to a fresh hash, so the loop converges quickly; the explicit
 * iteration cap is a safety net.
 */
export function resolveSourceFileSiblingFilenames(
  sourceFileUrl: string,
): void {
  const siblingsSet = cache.getHandlersForSource(sourceFileUrl);
  if (siblingsSet.size === 0) return;
  const siblings = [...siblingsSet] as ClientFunctionImpl[];

  const maxIterations = siblings.length + 2;
  for (let i = 0; i < maxIterations; i++) {
    let anyChanged = false;
    for (const sibling of siblings) {
      if (sibling._resolveFilename()) anyChanged = true;
    }
    if (!anyChanged) return;
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

/**
 * Revalidate every external (cross-file) handler registered as an
 * import on `sourceFileUrl`. Used by `ClientFunctionImpl.revalidateAndBuild`
 * so that editing only an imported source file (whose own handlers are
 * never directly engaged by the current request) still propagates a
 * filename hash change back to the consuming handler.
 */
async function revalidateExternalImports(
  sourceFileUrl: string,
  handlerDir: string,
): Promise<void> {
  const fileEntry = cache.files[sourceFileUrl];
  if (!fileEntry || fileEntry.externalImports.length === 0) return;

  const consumerRegistry = getImportRegistry(sourceFileUrl);

  for (const externalKey of fileEntry.externalImports) {
    const sep = externalKey.indexOf("::");
    if (sep === -1) continue;
    const importedSourceFileUrl = externalKey.slice(0, sep);
    const importedFnName = externalKey.slice(sep + 2);

    const importedHandlers = cache.getHandlersForSource(importedSourceFileUrl);
    for (const handler of importedHandlers) {
      const impl = handler as ClientFunctionImpl;
      if (impl.fnName !== importedFnName) continue;
      if (!cache.isHandlerProcessedThisPass(impl)) {
        await impl.revalidateAndBuild(handlerDir);
      }
      // Always sync the consumer's import registry to the imported
      // handler's current filename. `import()` set this entry once at
      // construction time, but the imported handler's filename can
      // change later when its source file is edited — without this
      // update, the consumer would keep emitting the stale filename
      // even after rebuilding.
      consumerRegistry.set(impl.fnName, impl.filename);
    }
  }
}
