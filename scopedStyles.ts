/**
 * Scoped Styles Registry module for @tinytools/hono-tools
 *
 * Provides shared registries for scoped CSS styles.
 * The actual implementation is in clientTools.ts.
 *
 * @module
 */

import {
  cache,
  generateStyleHash,
  normalizeSourceFileUrl,
} from "./clientTools.ts";

export const SCOPE_BOUNDARY_CLASS = "sb";
const GLOBAL_SCOPE_BOUNDARY_TOKEN = "global";

export type ClassNameValue = string | null | undefined | false;

export function mergeClassNames(...classNames: ClassNameValue[]): string {
  const classes = classNames
    .filter((className): className is string => typeof className === "string")
    .flatMap((className) => className.split(/\s+/))
    .filter(Boolean);

  return [...new Set(classes)].join(" ");
}

export type ScopedStyleBoundaryMode =
  | "boundary"
  | "selectors"
  | "none";

export type ScopedStyleLayer =
  | "global"
  | "unscoped"
  | "limited"
  | "normal"
  | "important"
  | "debug";

export interface ScopedStyleOptions {
  layer?: ScopedStyleLayer;
}

export interface ScopedStyleScopeConfig {
  mode: ScopedStyleBoundaryMode;
  selectors?: string[];
}

export interface ScopedStyleDefinition {
  css: string;
  scope: ScopedStyleScopeConfig;
  layer?: ScopedStyleLayer;
}

export type ScopedStyleInput = string | ScopedStyleDefinition;

const defaultScopeConfig: ScopedStyleScopeConfig = { mode: "boundary" };

export function normalizeCssWhitespace(cssContent: string): string {
  return cssContent.replace(/\s+/g, " ").trim();
}

function createScopedStyleDefinition(
  cssContent: string,
  scope: ScopedStyleScopeConfig,
  options: ScopedStyleOptions = {},
): ScopedStyleDefinition {
  return {
    css: cssContent,
    scope,
    layer: options.layer,
  };
}

function normalizeSelectors(selectors: string[] | undefined): string[] {
  const normalized = (selectors ?? [])
    .map((selector) => selector.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error(
      "Scoped style selector boundary requires at least one selector.",
    );
  }

  return normalized;
}

function normalizeScopeConfig(
  scope: ScopedStyleScopeConfig | undefined,
): ScopedStyleScopeConfig {
  const mode = scope?.mode ?? defaultScopeConfig.mode;
  if (mode === "selectors") {
    return {
      mode,
      selectors: normalizeSelectors(scope?.selectors),
    };
  }

  return { mode };
}

export function scopedTo(
  cssContent: string,
  selectors: string[],
  options: ScopedStyleOptions = {},
): ScopedStyleDefinition {
  return createScopedStyleDefinition(cssContent, {
    mode: "selectors",
    selectors,
  }, options);
}

export function unscoped(
  cssContent: string,
  options: ScopedStyleOptions = {},
): ScopedStyleDefinition {
  return createScopedStyleDefinition(cssContent, { mode: "none" }, options);
}

export const setCustomScope = {
  toSelectors: scopedTo,
  toBoundary(
    cssContent: string,
    options: ScopedStyleOptions = {},
  ): ScopedStyleDefinition {
    return createScopedStyleDefinition(
      cssContent,
      { mode: "boundary" },
      options,
    );
  },
  unscoped,
};

export function normalizeScopedStyleInput(
  input: ScopedStyleInput,
): {
  cssContent: string;
  scope: ScopedStyleScopeConfig;
  layer: ScopedStyleLayer | undefined;
} {
  if (typeof input === "string") {
    return {
      cssContent: input,
      scope: { ...defaultScopeConfig },
      layer: undefined,
    };
  }

  return {
    cssContent: input.css,
    scope: normalizeScopeConfig(input.scope),
    layer: input.layer,
  };
}

function serializeScopeConfig(scope: ScopedStyleScopeConfig): string {
  if (scope.mode === "selectors") {
    return `${scope.mode}:${(scope.selectors ?? []).join("|")}`;
  }
  return scope.mode;
}

/**
 * Interface for style implementations stored in the registry.
 * @internal
 */
export interface ScopedStyleEntry {
  styleName: string;
  cssContent: string;
  filename: string;
  sourceFileUrl?: string;
  scope: ScopedStyleScopeConfig;
  layer: ScopedStyleLayer;
  buildCssLayerContent(): string;
  buildCssContent(): string;
  revalidate(): boolean;
}

/** Global registry of all scoped styles for build process */
export const scopedStylesRegistry = new Map<string, ScopedStyleEntry>();

/**
 * Global registry of style bundles for the build process.
 * Maps bundle filename -> array of constituent ScopedStyleImpl instances.
 * Each ClientTools instance with scoped styles registers one bundle here.
 */
export const styleBundleRegistry = new Map<string, ScopedStyleEntry[]>();

/** Track which styles had filename changes this run */
export const changedStyleKeys = new Set<string>();

/**
 * Type for the tracked scoped styles - each style returns a class name string.
 * Usage: class={styled.myStyle}
 */
export type TrackedScopedStyles<T> = {
  [K in keyof T]: string;
};

/**
 * Helper type to extend all ScopedStyles in an object.
 * Transforms { foo: ScopedStyleImpl } to { foo: string }
 * Also includes helper methods for class composition.
 */
export type ActivateScopedStyles<T> =
  & TrackedScopedStyles<T>
  & {
    mergeClasses(...classNames: ClassNameValue[]): string;
  };

/**
 * Template literal tag for writing CSS with interpolation support.
 * Use this with the Styles constructor for a better authoring experience.
 *
 * @example
 * ```tsx
 * const padding = 16;
 * const myStyle = css`
 *   padding: ${padding}px;
 *   color: blue;
 * `;
 *
 * const styles = new tiny.Styles(import.meta.url, {
 *   myStyle,
 * });
 * ```
 */
export function css(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const cssContent = strings.reduce((acc, str, i) => {
    return acc + str + (values[i] ?? "");
  }, "");

  return normalizeCssWhitespace(cssContent);
}

/**
 * Internal implementation of a scoped style.
 * @internal
 */
export class ScopedStyleImpl {
  styleName: string;
  cssContent: string;
  filename: string;
  sourceFileUrl?: string;
  isGlobal: boolean;
  scope: ScopedStyleScopeConfig;
  layer: ScopedStyleLayer;
  private occurrenceIndex = 0;
  private hashInput: string = "";
  private cleanupReferenceFilename: string = "";

  constructor(
    styleName: string,
    cssContent: string,
    sourceFileUrl?: string,
    isGlobal = false,
    scope: ScopedStyleScopeConfig = defaultScopeConfig,
    layer?: ScopedStyleLayer,
  ) {
    const normalizedSourceFileUrl = normalizeSourceFileUrl(sourceFileUrl);
    const normalizedScope = normalizeScopeConfig(scope);
    const resolvedLayer = layer ??
      (isGlobal
        ? "global"
        : normalizedScope.mode === "none"
        ? "unscoped"
        : normalizedScope.mode === "selectors"
        ? "limited"
        : "normal");
    const hashInput = isGlobal
      ? `${cssContent}::${
        normalizedSourceFileUrl ?? ""
      }::layer:${resolvedLayer}`
      : `${cssContent}::${serializeScopeConfig(normalizedScope)}::${
        normalizedSourceFileUrl ?? ""
      }::layer:${resolvedLayer}`;

    // Get the occurrence index for this name in this file (0 for first, 1 for second, etc.)
    const occurrenceIndex = normalizedSourceFileUrl
      ? cache.getNextOccurrenceIndex(
        normalizedSourceFileUrl,
        styleName,
        "style",
      )
      : 0;

    let cachedFilename: string | undefined;
    if (normalizedSourceFileUrl) {
      cachedFilename = cache.getCachedStyle(
        normalizedSourceFileUrl,
        styleName,
        occurrenceIndex,
      );
    }

    let resolvedFilename: string;
    if (cachedFilename) {
      resolvedFilename = cachedFilename;
    } else {
      console.log(
        "Generating filename for scoped style by hashing:",
        styleName,
      );
      resolvedFilename = `${styleName}_${generateStyleHash(hashInput)}`;
    }

    if (normalizedSourceFileUrl) {
      cache.files[normalizedSourceFileUrl] ??= {
        mtimeMs: 0,
        externalImports: [],
        handlers: {},
        styles: {},
      };

      cache.setCachedStyle(
        normalizedSourceFileUrl,
        styleName,
        occurrenceIndex,
        resolvedFilename,
      );
    }

    this.styleName = styleName;
    this.cssContent = cssContent;
    this.filename = resolvedFilename;
    this.sourceFileUrl = normalizedSourceFileUrl;
    this.isGlobal = isGlobal;
    this.scope = normalizedScope;
    this.layer = resolvedLayer;
    this.occurrenceIndex = occurrenceIndex;
    this.hashInput = hashInput;
    this.cleanupReferenceFilename = cachedFilename ?? resolvedFilename;

    scopedStylesRegistry.set(this.filename, this);
  }

  get cleanupFilenameForCurrentBuild(): string {
    return this.cleanupReferenceFilename;
  }

  get staleFilenameForCleanup(): string | undefined {
    return this.cleanupReferenceFilename !== this.filename
      ? this.cleanupReferenceFilename
      : undefined;
  }

  markCurrentFilenameAsClean(): void {
    this.cleanupReferenceFilename = this.filename;
  }

  buildCssLayerContent(): string {
    if (this.isGlobal) {
      return this.cssContent;
    }

    const scopeEnd = this.buildScopeEndSelector();
    return `@scope (.${this.filename}) to (${scopeEnd}) {:scope {${this.cssContent}}}`;
  }

  buildCssContent(): string {
    const layerStart = `@layer ${this.layer} {`;
    const layerEnd = "}";
    return `${layerStart}${this.buildCssLayerContent()}${layerEnd}`;
  }

  private buildScopeEndSelector(): string {
    const scopeSelectors = this.scope.mode === "boundary"
      ? [`.${SCOPE_BOUNDARY_CLASS}`]
      : this.scope.mode === "selectors"
      ? [...(this.scope.selectors ?? [])]
      : [];

    scopeSelectors.push(
      `[data-scope-boundary~="${this.filename}"]`,
      `[data-scope-boundary~="${GLOBAL_SCOPE_BOUNDARY_TOKEN}"]`,
    );

    return [...new Set(scopeSelectors)].join(", ");
  }

  /**
   * Deferred validation and build. Called at request time via ensureBuilt().
   * Checks if the source file changed, re-hashes if needed, and writes the .css file.
   * Returns true if the filename changed.
   */
  revalidate(): boolean {
    if (!this.sourceFileUrl) return false;

    const mtimeChanged = cache.checkAndTrackMtimeChange(this.sourceFileUrl);
    if (!mtimeChanged) return false;

    const newFilename = `${this.styleName}_${
      generateStyleHash(this.hashInput)
    }`;
    if (newFilename === this.filename) {
      // Filename unchanged, but still ensure the cache entry exists
      // (it may have been cleared by resetHashDependentState)
      cache.setCachedStyle(
        this.sourceFileUrl,
        this.styleName,
        this.occurrenceIndex,
        this.filename,
      );
      return false;
    }

    const oldFilename = this.filename;
    // Remove old registry entry
    scopedStylesRegistry.delete(oldFilename);

    this.filename = newFilename;
    scopedStylesRegistry.set(this.filename, this);

    // Update cache
    cache.setCachedStyle(
      this.sourceFileUrl,
      this.styleName,
      this.occurrenceIndex,
      this.filename,
    );

    changedStyleKeys.add(`${this.sourceFileUrl}::${this.styleName}`);
    console.log(
      `Style ${this.styleName} filename changed: ${oldFilename} -> ${this.filename}`,
    );
    return true;
  }
}
