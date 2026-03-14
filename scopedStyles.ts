/**
 * Scoped Styles Registry module for @tiny-tools/hono
 *
 * Provides shared registries for scoped CSS styles.
 * The actual implementation is in clientTools.ts.
 *
 * @module
 */

import { cache, generateStyleHash } from "./clientTools.ts";

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
 * Use this with ClientTools styles option for a better authoring experience.
 *
 * @example
 * ```tsx
 * const padding = 16;
 * const myStyle = css`
 *   padding: ${padding}px;
 *   color: blue;
 * `;
 *
 * const tools = new ClientTools(import.meta.url, {
 *   styles: { myStyle },
 * });
 * ```
 */
export function css(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.reduce((acc, str, i) => {
    return acc + str + (values[i] ?? "");
  }, "");
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

  constructor(
    styleName: string,
    cssContent: string,
    sourceFileUrl?: string,
    isGlobal = false,
    scope: ScopedStyleScopeConfig = defaultScopeConfig,
    layer?: ScopedStyleLayer,
  ) {
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
      ? `${cssContent}::layer:${resolvedLayer}`
      : `${cssContent}::${
        serializeScopeConfig(normalizedScope)
      }::layer:${resolvedLayer}`;

    let cachedFilename: string | undefined;
    const mtimeChanged = sourceFileUrl
      ? cache.checkAndTrackMtimeChange(sourceFileUrl)
      : false;

    if (sourceFileUrl && !mtimeChanged) {
      cachedFilename = cache.files[sourceFileUrl]?.styles[styleName];
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

      if (sourceFileUrl) {
        const sourceMtimeMs = cache.getSourceFileMtimeMs(sourceFileUrl);
        if (sourceMtimeMs !== null) {
          cache.files[sourceFileUrl] ??= {
            mtimeMs: sourceMtimeMs,
            externalImports: [],
            handlers: {},
            styles: {},
          };
          const oldFilename = cache.files[sourceFileUrl].styles[styleName];

          if (oldFilename && oldFilename !== resolvedFilename) {
            console.log(
              `Style ${styleName} filename changed: ${oldFilename} -> ${resolvedFilename}`,
            );
            changedStyleKeys.add(`${sourceFileUrl}::${styleName}`);
          }

          cache.files[sourceFileUrl].styles[styleName] = resolvedFilename;
          cache.markDirty();
        }
      }
    }

    this.styleName = styleName;
    this.cssContent = cssContent;
    this.filename = resolvedFilename;
    this.sourceFileUrl = sourceFileUrl;
    this.isGlobal = isGlobal;
    this.scope = normalizedScope;
    this.layer = resolvedLayer;

    scopedStylesRegistry.set(this.filename, this);
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
}
