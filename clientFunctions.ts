/**
 * Client Functions Registry module for @tinytools/hono-tools
 *
 * Every tiny.Handlers / tiny.Signals instance compiles to one
 * browser module (a {@link HandlerBundle}) exporting each of its handlers by
 * name. Handlers are referenced as `<bundle filename>.<handler name>`.
 *
 * @module
 */

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

import { mkdir, rm, stat as fsStat, writeFile } from "node:fs/promises";
import {
  cache,
  emptySourceFileCacheEntry,
  generateFullHash,
  generateHandlerHash,
  memoryAssets,
  memoryBuild,
  normalizeSourceFileUrl,
} from "./clientTools.ts";

/** Global registry of every handler function, keyed by the original function. */
export const handlers: Map<AnyFunction, ClientFunctionImpl> = new Map();

/** Every handler bundle, for the build process. */
export const handlerBundles: Set<HandlerBundle> = new Set();

/** Bundles by the filenames handed out for them (see `HandlerBundle.filename`). */
const bundlesByFilename = new Map<string, HandlerBundle>();

/**
 * Handler files (`<bundle>.js`) that the given files import, directly or
 * transitively, and that are not in the given list themselves. Rendering them
 * as `modulepreload` lets the browser fetch the whole graph in parallel
 * instead of discovering one level of imports per round trip.
 */
export function handlerFileDependencies(files: Iterable<string>): string[] {
  const requested = new Set(files);
  const dependencies = new Set<string>();
  for (const file of requested) {
    const bundle = bundlesByFilename.get(file.replace(/\.js$/, ""));
    if (!bundle) continue;
    for (const filename of bundle.reachableFilenames) {
      const dependency = `${filename}.js`;
      if (!requested.has(dependency)) dependencies.add(dependency);
    }
  }
  return [...dependencies];
}

/**
 * Handlers visible as bare identifiers to object-form handlers of a source
 * file: every handler defined in that file plus those pulled in through
 * `imports: [...]`.
 */
const importsBySourceFileUrl = new Map<
  string,
  Map<string, ClientFunctionImpl>
>();

export function getImportRegistry(
  sourceFileUrl?: string,
): Map<string, ClientFunctionImpl> {
  const key = normalizeSourceFileUrl(sourceFileUrl) ?? "__global__";
  let registry = importsBySourceFileUrl.get(key);
  if (!registry) importsBySourceFileUrl.set(key, registry = new Map());
  return registry;
}

/** Reset all import registries - used for testing */
export function resetImportRegistries(): void {
  importsBySourceFileUrl.clear();
}

/** Create a unique key for a handler that includes its source file */
export function handlerKey(sourceFileUrl: string, name: string): string {
  return `${normalizeSourceFileUrl(sourceFileUrl) ?? sourceFileUrl}::${name}`;
}

/** Bundles whose filenames changed this run - keyed by "sourceFileUrl::#index" */
export const changedHandlerKeys = new Set<string>();

/** Source files with a bundle whose filename changed this run */
export const filesWithChangedHandlers = new Set<string>();

/** Bump when emitted bundle code changes shape, so stale files are not reused. */
const BUNDLE_FORMAT_VERSION = 1;

/** Cache key under `cache.files[source].handlers` for bundle filenames. */
const BUNDLE_CACHE_KEY = "#bundle";

/** `identity` string -> hash. Avoids rehashing unchanged sources every request. */
const identityHashes = new Map<string, string>();

function hashIdentity(identity: string): string {
  let hash = identityHashes.get(identity);
  if (!hash) identityHashes.set(identity, hash = generateFullHash(identity));
  return hash;
}

/** A single handler inside a bundle. */
export class ClientFunctionImpl<
  T extends AnyFunction = AnyFunction,
  FName extends string = string,
> {
  constructor(
    readonly fnName: FName,
    public fn: T,
    readonly bundle: HandlerBundle,
  ) {
    if (typeof fn !== "function") {
      throw new Error("ClientFunction requires a function");
    }
    Object.defineProperty(fn, "name", { value: fnName });
    handlers.set(fn, this);
  }

  get filename(): string {
    return this.bundle.filename;
  }

  get sourceFileUrl(): string | undefined {
    return this.bundle.sourceFileUrl;
  }

  /** `<bundle>.<name>`: what `tt-handler-*` attributes carry. */
  get reference(): string {
    return `${this.bundle.filename}.${this.fnName}`;
  }

  /** Inline expression used by the `handlers` API and CSP-disabled output. */
  get expression(): string {
    return `handlers.${this.reference}.call(this, event)`;
  }

  /** Bundle code with this handler as the default export (for tests/tools). */
  buildCode(): Promise<string> {
    return this.bundle.buildCode(this.fnName);
  }
}

export type HandlerBundleOptions = {
  sourceFileUrl?: string;
  /** Construction order of this bundle within its source file. */
  index: number;
  /** Stateful bundles are unique per instance even when sources match. */
  stateful: boolean;
  storedBinding: string;
  /** Explicit `tiny.imports()` dependencies; absent for object-form bundles. */
  dependencies?: ReadonlyMap<string, ClientFunctionImpl>;
  prelude?: string;
};

/**
 * One browser module containing every handler of a tools instance.
 *
 * The filename is a content hash over this bundle and every bundle it
 * (transitively) imports, so a file that exists on disk is always current and
 * any change anywhere in the import graph yields new URLs for its consumers.
 */
export class HandlerBundle {
  readonly functions: Map<string, ClientFunctionImpl> = new Map();
  readonly sourceFileUrl?: string;
  readonly index: number;
  readonly stateful: boolean;
  readonly storedBinding: string;
  readonly prelude: string;
  #explicitDependencies?: Map<string, ClientFunctionImpl>;
  #filename: string | undefined;
  /** Last filename written to disk, starting from the persisted cache entry. */
  #writtenFilename: string | undefined;

  constructor(options: HandlerBundleOptions) {
    this.sourceFileUrl = normalizeSourceFileUrl(options.sourceFileUrl);
    this.index = options.index;
    this.stateful = options.stateful;
    this.storedBinding = options.storedBinding;
    this.prelude = options.prelude ?? "";
    this.#explicitDependencies = options.dependencies &&
      new Map(options.dependencies);
    handlerBundles.add(this);
    if (this.sourceFileUrl) {
      const cached = cache.getCachedHandler(
        this.sourceFileUrl,
        BUNDLE_CACHE_KEY,
        this.index,
      );
      if (cache.trustCache) this.#filename = cached;
      else this.#writtenFilename = cached;
    }
  }

  add(name: string, fn: AnyFunction): ClientFunctionImpl {
    const impl = new ClientFunctionImpl(name, fn, this);
    this.functions.set(name, impl);
    this.#filename = undefined;
    return impl;
  }

  /** Handlers from other bundles this bundle may reference, keyed as in source. */
  get dependencies(): Map<string, ClientFunctionImpl> {
    if (this.#explicitDependencies) return this.#explicitDependencies;
    // Object-form handlers reach other handlers of their source file (and
    // explicit imports) by bare name. Only names that appear in the source
    // are kept, so unrelated siblings do not affect this bundle's hash.
    const source = [...this.functions.values()].map((impl) =>
      impl.fn.toString()
    ).join("\n");
    const referenced = new Set(source.match(/[$A-Z_a-z][$\w]*/g));
    const dependencies = new Map<string, ClientFunctionImpl>();
    for (const [name, impl] of getImportRegistry(this.sourceFileUrl)) {
      if (
        impl.bundle !== this && !this.functions.has(name) &&
        referenced.has(name)
      ) {
        dependencies.set(name, impl);
      }
    }
    return dependencies;
  }

  /** Drop explicit dependencies that the compiled code never uses. */
  async pruneDependencies(): Promise<void> {
    if (!this.#explicitDependencies) return;
    const { dependencies } = await this.#compile(
      new Map(
        [...this.#explicitDependencies].map(([key, impl], index) => [key, {
          path: `./__tiny_dependency_${index}.js`,
          exportName: impl.fnName,
        }]),
      ),
    );
    const live = new Set(dependencies);
    for (const key of this.#explicitDependencies.keys()) {
      if (!live.has(key)) this.#explicitDependencies.delete(key);
    }
    this.#filename = undefined;
  }

  /** Everything that determines this bundle's own emitted source. */
  get identity(): string {
    return [
      `bundle-v${BUNDLE_FORMAT_VERSION}`,
      this.sourceFileUrl ?? "",
      this.stateful ? `stateful:${this.index}:${this.storedBinding}` : "",
      this.prelude,
      ...[...this.functions].map(([name, impl]) =>
        `${name}=${impl.fn.toString()}`
      ),
    ].join("\n");
  }

  get filename(): string {
    const filename = this.#filename ??= this.#computeFilename();
    bundlesByFilename.set(filename, this);
    return filename;
  }

  /** Filenames of this bundle and every bundle it transitively imports. */
  get reachableFilenames(): string[] {
    return [...this.#reachable()].map((bundle) => bundle.filename);
  }

  /** Drop the memoised filename so the next access rehashes the import graph. */
  invalidate(): void {
    this.#filename = undefined;
  }

  /** This bundle and every bundle it transitively imports. */
  #reachable(): Set<HandlerBundle> {
    const reachable = new Set<HandlerBundle>([this]);
    for (const bundle of reachable) {
      for (const impl of bundle.dependencies.values()) {
        reachable.add(impl.bundle);
      }
    }
    return reachable;
  }

  #computeFilename(): string {
    const reachable = this.#reachable();
    // This bundle's own identity comes first so bundles that import each
    // other (and so share a reachable set) still get distinct names.
    const parts = [...reachable].map((bundle) =>
      [
        hashIdentity(bundle.identity),
        ...[...bundle.dependencies].map(([key, impl]) =>
          `${key}->${hashIdentity(impl.bundle.identity)}.${impl.fnName}`
        ).sort(),
      ].join(",")
    ).sort();
    parts.unshift(hashIdentity(this.identity));
    const baseName = this.sourceFileUrl?.replace(/\\/g, "/").split("/").pop()
      ?.replace(/\.[^.]+$/, "").replace(/\W/g, "_") || "handlers";
    const filename = `${baseName}_${generateHandlerHash(parts.join("\n"))}`;
    if (this.sourceFileUrl) {
      cache.files[this.sourceFileUrl] ??= emptySourceFileCacheEntry();
      cache.setCachedHandler(
        this.sourceFileUrl,
        BUNDLE_CACHE_KEY,
        this.index,
        filename,
      );
    }
    return filename;
  }

  #compile(
    dependencies: ReadonlyMap<string, { path: string; exportName: string }>,
    defaultExport?: string,
  ) {
    return import("./handlerNamespace.ts").then(({ compileHandlerBundle }) =>
      compileHandlerBundle({
        functions: new Map(
          [...this.functions].map(([name, impl]) => [name, impl.fn.toString()]),
        ),
        prelude: this.prelude,
        dependencies,
        stored: this.stateful && this.storedBinding,
        defaultExport,
        register: this.filename,
      })
    );
  }

  async buildCode(defaultExport?: string): Promise<string> {
    return (await this.#compile(
      new Map(
        [...this.dependencies].map(([key, impl]) => [key, {
          path: `./${impl.filename}.js`,
          exportName: impl.fnName,
        }]),
      ),
      defaultExport,
    )).code;
  }

  /**
   * Make sure this bundle and everything it imports exist in `handlerDir`
   * (or in memory with `--none`). Content-addressed filenames mean an
   * existing file never needs rewriting; a previous filename is removed.
   */
  async ensureWritten(
    handlerDir: string,
    options: { fresh?: boolean } = {},
  ): Promise<boolean> {
    if (cache.isHandlerProcessedThisPass(this)) return false;
    const pending = [...this.#reachable()].filter((bundle) =>
      !cache.isHandlerProcessedThisPass(bundle)
    );
    // Filenames depend on the whole graph, so refresh them all before any
    // bundle is written with its imports' names.
    if (!cache.trustCache) {
      for (const bundle of pending) bundle.invalidate();
    }
    let written = false;
    for (const bundle of pending) {
      cache.markHandlerProcessedThisPass(bundle);
      const wrote = await bundle.#write(handlerDir, options);
      if (bundle === this) written = wrote;
    }
    return written;
  }

  async #write(
    handlerDir: string,
    options: { fresh?: boolean },
  ): Promise<boolean> {
    const filename = this.filename;
    const previous = this.#writtenFilename;
    this.#writtenFilename = filename;
    if (previous && previous !== filename) {
      changedHandlerKeys.add(
        handlerKey(this.sourceFileUrl ?? "", `#${this.index}`),
      );
      if (this.sourceFileUrl) filesWithChangedHandlers.add(this.sourceFileUrl);
      const stillUsed = [...handlerBundles].some((bundle) =>
        bundle !== this && bundle.#writtenFilename === previous
      );
      if (!stillUsed) {
        if (memoryBuild) memoryAssets.delete(`/handlers/${previous}.js`);
        else await rm(`${handlerDir}/${previous}.js`).catch(() => {});
      }
    }

    if (memoryBuild) {
      const assetPath = `/handlers/${filename}.js`;
      if (memoryAssets.has(assetPath)) return false;
      memoryAssets.set(assetPath, await this.buildCode());
      return true;
    }
    const path = `${handlerDir}/${filename}.js`;
    // An edited source always rewrites its bundles, which also repairs files
    // left stale under an unchanged name (e.g. by a framework upgrade).
    const sourceChanged = this.sourceFileUrl !== undefined &&
      cache.checkAndTrackMtimeChange(this.sourceFileUrl);
    if (
      !options.fresh && !sourceChanged &&
      await fsStat(path).then(() => true, () => false)
    ) {
      return false;
    }
    const code = await this.buildCode();
    await mkdir(handlerDir, { recursive: true });
    await writeFile(path, code);
    console.log(`Handler bundle written: ${path}`);
    return true;
  }
}

/**
 * Revalidate every style registered against `sourceFileUrl`. Handler bundles
 * need no revalidation: their content-addressed files are written on use.
 */
export async function revalidateSourceFileSiblings(
  sourceFileUrl: string,
): Promise<void> {
  const { revalidateScopedStyleSibling } = await import("./scopedStyles.ts");
  for (const sibling of cache.getStylesForSource(sourceFileUrl)) {
    if (cache.isStyleProcessedThisPass(sibling as object)) continue;
    await revalidateScopedStyleSibling(sibling);
  }
}
