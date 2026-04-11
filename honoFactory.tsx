/**
 * Hono Factory module for @tinytools/hono-tools
 *
 * Provides setup functions and middleware for enhancing Hono apps with
 * ClientTools (client-side functions and scoped styles).
 *
 * @module
 */

import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Child } from "hono/jsx";
import {
  contextStorage,
  getContext as honoGetContext,
} from "hono/context-storage";
import {
  type ActivatedClientTools,
  type ClientTools,
  Handlers,
  imports as importTools,
  resolveToolAccessFromChain,
  setGeneratedFilenameHashLength,
  setGeneratedHandlerHashLength,
  setGeneratedStyleHashLength,
  Styles,
  type ToolResolutionTarget,
} from "./clientTools.ts";
import type { ActivateClientFunctions } from "./jsx-runtime.ts";
import { type ActivateScopedStyles, css } from "./scopedStyles.ts";
import { serveStatic } from "hono/deno";
import { jsxRenderer } from "hono/jsx-renderer";
import { AssetTags } from "./components/AssetTags.tsx";
import type { JSX } from "hono/jsx/jsx-runtime";
import { clientFiles } from "./client/dist/manifest.ts";
import { trackConnectedClients } from "./sse.ts";

/** URL prefix for package-provided client scripts */
export const TINYTOOLS_CLIENT_PREFIX = "/_tinytools";

const ROUTE_LAYOUT_APPLIED_KEY = "tinyToolsRouteLayoutApplied";

// Pre-resolve URLs for all package client files (works for both file:// and https://)
const packageClientFileUrls = new Map<string, string>();
for (const file of clientFiles) {
  packageClientFileUrls.set(file, import.meta.resolve(`./client/dist/${file}`));
}

// ============================================================================
// Type Helpers
// ============================================================================

// deno-lint-ignore no-explicit-any
type AnyClientTools = ClientTools<any, any, any>;

/** Extract raw functions type from ClientTools */
// deno-lint-ignore no-explicit-any
type ExtractFunctions<T> = T extends ClientTools<infer F, any, any> ? F
  : object;

/** Extract raw styles type from ClientTools */
// deno-lint-ignore no-explicit-any
type ExtractStyles<T> = T extends ClientTools<any, infer S, any> ? S : object;

/**
 * Infer the activated tools type from a ClientTools instance.
 * Use this for optional ContextVariableMap augmentation or manual type imports.
 *
 * @example
 * ```ts
 * // Optional: augment ContextVariableMap for typed c.var.tools
 * declare module "hono" {
 *   interface ContextVariableMap {
 *     tools: InferTools<typeof myTools>;
 *   }
 * }
 *
 * // Or import for manual typing
 * import type { InferTools } from "@tinytools/hono-tools";
 * type MyTools = InferTools<typeof myTools>;
 * ```
 */
export type InferTools<T extends AnyClientTools> = T extends // deno-lint-ignore no-explicit-any
ClientTools<infer F, infer S, any> ? ActivatedClientTools<F, S>
  : never;

/**
 * Helper to extract all functions from a tools intersection.
 * Works with RawToolsType, MergedToolsAccess, or intersections thereof.
 * Returns object when property doesn't exist instead of never.
 */
type ExtractAllFunctions<T> = T extends { __functions: infer F } ? F : object;

/**
 * Helper to extract all styles from a tools intersection.
 * Works with RawToolsType, MergedToolsAccess, or intersections thereof.
 * Returns object when property doesn't exist instead of never.
 */
type ExtractAllStyles<T> = T extends { __styles: infer S } ? S : object;

/**
 * Raw tools type for middleware - stores raw F/S types in __functions/__styles.
 * When intersected, these phantom properties merge correctly.
 */
interface RawToolsType<TFunctions, TStyles> {
  /** Phantom property for type merging - stores function types */
  readonly __functions: TFunctions;
  /** Phantom property for type merging - stores style types */
  readonly __styles: TStyles;
  /**
   * Access functions - type comes from __functions.
   */
  readonly fn: ActivateClientFunctions<TFunctions>;
  /**
   * Access styles - type comes from __styles.
   */
  readonly styled: ActivateScopedStyles<TStyles>;
  /**
   * Extend with local tools. Returns typed access to all merged functions and styles.
   * Uses `this` to capture the actual object type (including any intersections),
   * then extracts __functions/__styles from it.
   */
  extendWithImports<TLocalTools extends [AnyClientTools, ...AnyClientTools[]]>(
    ...localTools: TLocalTools
  ): Promise<
    MergedToolsAccess<
      TFunctions,
      TStyles,
      TLocalTools
    >
  >;
}

/**
 * Result of extend - provides typed access to merged functions and styles.
 */
type MergedToolsAccess<
  TAccumulatedFunctions,
  TAccumulatedStyles,
  TLocalTools extends AnyClientTools[],
> = {
  readonly __functions:
    & TAccumulatedFunctions
    & UnionToIntersection<ExtractFunctions<TLocalTools[number]>>;
  readonly __styles:
    & TAccumulatedStyles
    & UnionToIntersection<ExtractStyles<TLocalTools[number]>>;
  readonly fn: ActivateClientFunctions<
    & TAccumulatedFunctions
    & UnionToIntersection<ExtractFunctions<TLocalTools[number]>>
  >;
  readonly styled: ActivateScopedStyles<
    TAccumulatedStyles & UnionToIntersection<ExtractStyles<TLocalTools[number]>>
  >;
  extendWithImports<TNextTools extends [AnyClientTools, ...AnyClientTools[]]>(
    ...localTools: TNextTools
  ): Promise<
    MergedToolsAccess<
      & TAccumulatedFunctions
      & UnionToIntersection<ExtractFunctions<TLocalTools[number]>>,
      & TAccumulatedStyles
      & UnionToIntersection<ExtractStyles<TLocalTools[number]>>,
      TNextTools
    >
  >;
};

/** Convert ClientTools to RawToolsType for middleware typing */
type InferRawTools<T extends AnyClientTools> = T extends // deno-lint-ignore no-explicit-any
ClientTools<infer F, infer S, any> ? RawToolsType<F, S>
  : never;

// Helper type to convert union to intersection
// deno-lint-ignore no-explicit-any
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends
  ((k: infer I) => void) ? I : never;

/** Extract merged functions from RawToolsType intersection */
type ExtractMergedFunctions<T> = T extends { __functions: infer F } ? F : never;

/** Extract merged styles from RawToolsType intersection */
type ExtractMergedStyles<T> = T extends { __styles: infer S } ? S : never;

// Helper type to combine tools array into merged raw tools
type CombinedToolsRaw<T extends AnyClientTools[]> = UnionToIntersection<
  { [K in keyof T]: InferRawTools<T[K]> }[number]
>;

type CombinedTools<T extends AnyClientTools[]> = RawToolsType<
  ExtractMergedFunctions<CombinedToolsRaw<T>>,
  ExtractMergedStyles<CombinedToolsRaw<T>>
>;

/**
 * Base type for tools when no type parameter is provided to getTools().
 * Provides the extendWithImports() method for adding local tools.
 * Uses `this` type parameter to preserve accumulated types from middleware.
 */
export type BaseTools = {
  /** Phantom property for type merging - stores function types */
  readonly __functions?: unknown;
  /** Phantom property for type merging - stores style types */
  readonly __styles?: unknown;
  /**
   * Extend with component-local tools.
   * Returns a typed tools object that merges accumulated types with local tools.
   * Uses `this` to properly infer accumulated types from middleware.
   */
  extendWithImports<
    TSelf,
    TLocalTools extends [AnyClientTools, ...AnyClientTools[]],
  >(
    this: TSelf,
    ...localTools: TLocalTools
  ): Promise<
    MergedToolsAccess<
      ExtractAllFunctions<TSelf>,
      ExtractAllStyles<TSelf>,
      TLocalTools
    >
  >;
};

/**
 * Helper type for augmenting Hono's ContextVariableMap with TinyTools.
 * Merges your custom variables with the required `tools` property.
 *
 * @example
 * ```ts
 * type Variables = {
 *   user: User;
 *   session: Session;
 * };
 *
 * declare module "hono" {
 *   interface ContextVariableMap extends TinyToolsVariables<Variables> {}
 * }
 * ```
 */
export type TinyToolsVariables<V = object> = V & { tools: BaseTools };

/**
 * Get tools from the current request context.
 * Primary API for accessing ClientTools in components.
 *
 * @example Without type parameter - local tools only
 * ```tsx
 * // Returns BaseTools - extendWithImports() returns only local tool types
 * const { fn } = getTools().extendWithImports(localTools);
 * ```
 *
 * @example With ancestor tools
 * ```tsx
 * import type { globalTools } from "./main.tsx";
 *
 * // Returns typed tools with ancestors, extendWithImports() merges local + ancestors
 * const { fn } = getTools<[typeof globalTools]>().extendWithImports(localTools);
 * ```
 *
 * @example With multiple ancestor tools
 * ```tsx
 * import type { globalTools } from "./main.tsx";
 * import type { parentTools } from "./parent.tsx";
 *
 * // Combine multiple ancestor tools
 * const { fn } = getTools<[typeof parentTools, typeof globalTools]>().extendWithImports(localTools);
 * ```
 */
export function getTools<
  TAncestorTools extends AnyClientTools[] | undefined = undefined,
>(): TAncestorTools extends AnyClientTools[] ? CombinedTools<TAncestorTools>
  : BaseTools {
  const c = honoGetContext<{ Variables: { tools: BaseTools } }>();
  return c.var.tools as TAncestorTools extends AnyClientTools[]
    ? CombinedTools<TAncestorTools>
    : BaseTools;
}

// ============================================================================
// sharedImports middleware implementation
// ============================================================================

/**
 * Create a typed middleware that extends tools with one or more local tools.
 * The local tools type is automatically inferred and merged by Hono's `.use()`.
 *
 * @example Root route (no ancestors):
 * ```ts
 * const localHandlers = new tiny.Handlers(import.meta.url, {
 *   handleClick() { console.log("clicked"); },
 * });
 *
 * export const route = new Hono()
 *   .use(tiny.middleware.sharedImports(localHandlers))
 *   .get("/", (c) => {
 *     const { fn } = c.var.tools;  // Fully typed!
 *     return c.render(<div onClick={fn.handleClick}>Click</div>);
 *   });
 * ```
 *
 * @example Root route with multiple tool groups:
 * ```ts
 * export const route = new Hono()
 *   .use(tiny.middleware.sharedImports(localStyles, localHandlers))
 *   .get("/", (c) => {
 *     c.var.tools.fn.handleClick;
 *     c.var.tools.styled.panel;
 *   });
 * ```
 *
 * @example Child route with ancestor tools:
 * ```tsx
 * import type { globalTools } from "./main.tsx";
 * import type { localTools as parentTools } from "./parent.tsx";
 *
 * const localHandlers = new tiny.Handlers(import.meta.url, {
 *   localHandler() {},
 * });
 *
 * // Only specify ancestors - localTools type is inferred from tiny.middleware.sharedImports!
 * export const route = new Hono<withAncestors<[typeof parentTools, typeof globalTools]>>()
 *   .use(tiny.middleware.sharedImports(localHandlers))
 *   .get("/", (c) => {
 *     c.var.tools.fn.localHandler;   // Inferred from tiny.middleware.sharedImports
 *     c.var.tools.fn.parentHandler;  // From ancestors
 *     c.var.tools.fn.globalHandler;  // From ancestors
 *   });
 * @example Without tools (just declares BaseTools for type inference):
 * ```tsx
 * export const route = new Hono()
 *   .use(tiny.middleware.sharedImports())  // Declares tools: BaseTools for downstream handlers
 *   .get("/", (c) => {
 *     const { fn } = c.var.tools.extendWithImports(localTools);
 *   });
 * ```
 */
function createSharedImportsMiddleware(): MiddlewareHandler<
  { Variables: { tools: BaseTools } }
>;
function createSharedImportsMiddleware<
  const TTools extends [AnyClientTools, ...AnyClientTools[]],
>(
  ...tools: TTools
): MiddlewareHandler<{ Variables: { tools: CombinedTools<TTools> } }>;
// deno-lint-ignore no-explicit-any
function createSharedImportsMiddleware(
  ...tools: AnyClientTools[]
): MiddlewareHandler<any> {
  return async (c, next) => {
    if (tools.length > 0) {
      const toolsToExtend = tools as [AnyClientTools, ...AnyClientTools[]];
      // Ensure deferred build runs for tools accessed via c.var.tools (without engage())
      await Promise.all(
        toolsToExtend.map(
          // deno-lint-ignore no-explicit-any
          (tool) => (tool as any).ensureBuilt(),
        ),
      );
      const currentTools = c.var.tools as BaseTools;
      // deno-lint-ignore no-explicit-any
      c.set(
        "tools",
        await currentTools.extendWithImports(...toolsToExtend) as any,
      );
    }
    await next();
  };
}

/**
 * Middleware to add global styles to the accessed styles for every request.
 * This ensures the style's CSS files are included in AssetTags on every page.
 *
 * Use this with styles defined using `globalStyles` option in ClientTools.
 *
 * @param styles - One or more ScopedStyleImpl instances (from globalStyles option)
 *
 * @example
 * ```ts
 * const globalTools = new tiny.Styles(import.meta.url, {
 *   globalStyles: css`body { font-family: sans-serif; }`,
 * }, { global: true });
 *
 * const app = new Hono()
 *   .use(...tiny.middleware.core())
 *   .use(tiny.middleware.sharedImports(globalTools))
 *   .use(tiny.middleware.globalStyles(...globalTools.globalStyles));
 * ```
 */
export function addGlobalStyles(
  ...styles: { filename: string }[]
): MiddlewareHandler {
  return async (c, next) => {
    const accessedStyleFiles = c.get("accessedStyleFiles") as Set<string> ||
      new Set<string>();
    for (const style of styles) {
      accessedStyleFiles.add(style.filename + ".css");
    }
    c.set("accessedStyleFiles", accessedStyleFiles);
    await next();
  };
}

/**
 * Pre-render layout JSX to ensure all tools/styles are registered before
 * the root middleware's AssetTags renders.
 *
 * In nested jsxRenderer middleware, the return JSX renders AFTER the parent
 * middleware's JSX (where AssetTags lives). This function pre-renders the
 * layout JSX to a string, which triggers all component renders and tool
 * registrations, then returns it as raw HTML.
 *
 * This is more convenient than `preregisterTools` because:
 * - Works automatically with any components the layout uses
 * - No need to manually track which tools each component needs
 * - Just wrap your return JSX once
 *
 * @example
 * ```tsx
 * jsxRenderer(({ children, Layout, title }) => {
 *   // Instead of manually preregistering tools:
/**
 * Register layout tools/styles by doing a dummy render.
 * Takes a render function that receives children placeholder, runs it once
 * to trigger tool/style registration, then discards the result.
 *
 * @param renderLayout - Function that takes children placeholder and returns layout JSX
 *
 * @example
 * ```tsx
 * jsxRenderer(async ({ children, Layout, title }) => {
 *   if (partialNav) return <>{children}</>;
 *
 *   // Dummy render to register TwoColumnSplit's tools/styles
 *   await withLayoutTools((content) => (
 *     <TwoColumnSplit contentPanelChildren={content}>
 *       <Navigation ... />
 *     </TwoColumnSplit>
 *   ));
 *
 *   // Return actual JSX normally
 *   return (
 *     <Layout title={title}>
 *       <TwoColumnSplit contentPanelChildren={children}>
 *         <Navigation ... />
 *       </TwoColumnSplit>
 *     </Layout>
 *   );
 * })
 * ```
 */
export async function withLayoutTools(
  renderLayout: (children: Child) => JSX.Element | Promise<JSX.Element>,
): Promise<void> {
  // Dummy render with null to register tools/styles
  (await renderLayout(null)).toString();
}

/**
 * Type for route layout component props
 */
export type RouteLayoutProps = {
  children: Child;
};

/**
 * Create a middleware that wraps routes with a layout component.
 * Handles partial navigation (source-url header) by returning children directly,
 * otherwise wraps children in the provided layout component.
 *
 * The layout is rendered once as a dummy (with empty fragment) to register
 * any tools/styles before the actual render.
 *
 * @param LayoutComponent - A JSX component that receives children and context
 *
 * @example With a simple component
 * ```tsx
 * const MyLayout = ({ children }: { children: Child }) => (
 *   <TwoColumnSplit contentPanelChildren={children}>
 *     <nav>Sidebar</nav>
 *   </TwoColumnSplit>
 * );
 *
 * export const route = new Hono()
 *   .use(addRouteLayout(MyLayout))
 *   .get("/", (c) => c.render(<div>Content</div>));
 * ```
 *
 * @example With inline JSX function
 * ```tsx
 * export const route = new Hono()
 *   .use(tiny.middleware.sharedImports())
 *   .use(addRouteLayout(({ children }, c) => (
 *     <TwoColumnSplit contentPanelChildren={children}>
 *       <nav>Sidebar</nav>
 *     </TwoColumnSplit>
 *   )))
 *   .get("/", (c) => c.render(<div>Content</div>));
 * ```
 */
export function addRouteLayout<
  V extends Record<string, unknown> = Record<string, never>,
>(
  LayoutComponent: (
    props: RouteLayoutProps,
    c: Context,
  ) => JSX.Element | Promise<JSX.Element>,
): MiddlewareHandler {
  // deno-lint-ignore no-explicit-any
  return jsxRenderer(async ({ children, Layout, title }, c: any) => {
    const sourceUrl = !!c.req.header("source-url");
    if (!sourceUrl) {
      c.set(ROUTE_LAYOUT_APPLIED_KEY, true);
    }

    // Await children to ensure they are rendered
    await children;

    // Partial navigation - return children inside Layout without our route layout
    if (sourceUrl) {
      return <Layout title={title}>{children}</Layout>;
    }

    // Full page navigation - dummy render to register tools/styles defined in the layout
    await withLayoutTools((content) => (
      LayoutComponent({ children: content }, c)
    ));

    // Return actual JSX with layout wrapping children
    return (
      <Layout title={title}>
        {LayoutComponent({ children }, c)}
      </Layout>
    );
  }, {
    stream: true,
  }) as MiddlewareHandler<{ Variables: V & { tools: BaseTools } }>;
}

/**
 * Type helper for Hono generic to declare ancestor tools.
 * Local tools are inferred from tiny.middleware.sharedImports() - only ancestors need to be declared.
 *
 * @example
 * ```tsx
 * // Ancestors only - local type comes from tiny.middleware.sharedImports(localTools)
 * new Hono<withAncestors<[typeof parentTools, typeof globalTools]>>()
 *   .use(tiny.middleware.sharedImports(localTools))
 * ```
 */
export type withAncestors<TAncestors extends AnyClientTools[]> = {
  Variables: { tools: CombinedTools<TAncestors> };
};

// ============================================================================
// ContextRenderer declaration
// ============================================================================

declare module "hono" {
  interface ContextRenderer {
    (
      content: string | Promise<string>,
      props?: {
        title?: string;
      },
    ): Response;
  }
}

// ============================================================================
// tiny - Opt-in middleware API for Hono apps
// ============================================================================

/** Internal type for the tools proxy object */
interface ToolsProxy {
  fn: unknown;
  styled: unknown;
  extendWithImports(...localTools: AnyClientTools[]): Promise<ToolsProxy>;
}

/**
 * Options for `tiny.middleware.core()` and `tiny.middleware.all()`.
 */
export type ClientToolsOptions = {
  /**
   * Number of hash characters used in generated client function/style filenames.
   * Valid range is 1-8, values outside range are clamped.
   */
  generatedFilenameHashLength?: number;
  /**
   * Number of hash characters used in generated client handler filenames.
   * Valid range is 1-8, values outside range are clamped.
   */
  generatedHandlerHashLength?: number;
  /**
   * Number of hash characters used in generated style filenames and class names.
   * Valid range is 1-8, values outside range are clamped.
   */
  generatedStyleHashLength?: number;
};

/** Options for `tiny.middleware.navApiTools()`. Reserved for future use. */
export type NavApiToolsOptions = Record<string, never>;

/** Options for `tiny.middleware.sseTools()`. Reserved for future use. */
export type SseToolsOptions = Record<string, never>;

/** Options for `tiny.middleware.localRoutes()`. Reserved for future use. */
export type LocalRoutesOptions = Record<string, never>;

/** Options for `tiny.middleware.webComponents()`. Reserved for future use. */
export type WebComponentsOptions = Record<string, never>;

/**
 * Create a middleware that sets up request-scoped tracking for both
 * functions and styles. Internal use only.
 * @internal
 */
function createToolsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // Initialize fresh tracking sets for this request
    const accessedHandlerFiles = new Set<string>();
    const accessedStyleFiles = new Set<string>();
    c.set("accessedHandlerFiles", accessedHandlerFiles);
    c.set("accessedStyleFiles", accessedStyleFiles);

    // Feature flags set — feature middleware adds entries before rendering
    c.set("tinyToolsFeatures", new Set<string>());

    // Helper to create a tracking proxy for functions or styles
    const createTrackingProxy = (
      tools: ToolResolutionTarget,
      type: "function" | "style",
      parentProxy?: unknown,
    ): unknown => {
      const accessedFiles = type === "function"
        ? accessedHandlerFiles
        : accessedStyleFiles;
      const extension = type === "function" ? ".js" : ".css";

      return new Proxy(tools, {
        get(_target, prop, receiver) {
          const resolved = resolveToolAccessFromChain(
            [tools],
            type,
            prop,
            (_usageType, filename) => {
              accessedFiles.add(filename + extension);
            },
          );

          if (resolved !== undefined) {
            return resolved;
          }

          // Fall through to parent proxy for inherited items
          if (parentProxy && typeof prop === "string") {
            const parentValue = (parentProxy as Record<string, unknown>)[prop];
            if (parentValue !== undefined) {
              return parentValue;
            }
          }

          return Reflect.get(tools as object, prop, receiver);
        },
      });
    };

    // Helper to create the combined tools object
    const createToolsProxy = (
      functionsProxy: unknown,
      stylesProxy: unknown,
    ): ToolsProxy => ({
      get fn() {
        return functionsProxy;
      },
      get styled() {
        return stylesProxy;
      },
      async extendWithImports(...localTools: AnyClientTools[]) {
        // Ensure deferred build runs for tools extended at request time
        await Promise.all(
          // deno-lint-ignore no-explicit-any
          localTools.map((t) => (t as any).ensureBuilt()),
        );

        let nextFunctionsProxy = functionsProxy;
        let nextStylesProxy = stylesProxy;

        for (const tools of localTools) {
          nextFunctionsProxy = createTrackingProxy(
            tools,
            "function",
            nextFunctionsProxy,
          );
          nextStylesProxy = createTrackingProxy(
            tools,
            "style",
            nextStylesProxy,
          );
        }

        return createToolsProxy(
          nextFunctionsProxy,
          nextStylesProxy,
        );
      },
    });

    // Create root tools proxy - starts empty, extended via extendWithImports()
    const emptyTarget: ToolResolutionTarget = {
      _handlerFilenames: new Map<string, string>(),
      _styleFilenames: new Map<string, string>(),
      _styles: new Map(),
    };

    c.set(
      "tools",
      createToolsProxy(
        createTrackingProxy(emptyTarget, "function"),
        createTrackingProxy(emptyTarget, "style"),
      ) as unknown as BaseTools,
    );

    await next();
  };
}

/**
 * Middleware that serves pre-built package client JS files from /_tinytools/*.
 * Resolves files via import.meta.resolve so it works for both local and JSR.
 */
function servePackageClientFiles(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith(TINYTOOLS_CLIENT_PREFIX + "/")) {
      return next();
    }

    const fileName = path.slice(TINYTOOLS_CLIENT_PREFIX.length + 1);
    const resolvedUrl = packageClientFileUrls.get(fileName);
    if (!resolvedUrl) {
      return next();
    }

    if (resolvedUrl.startsWith("file://")) {
      const { fromFileUrl } = await import("jsr:@std/path@^1");
      const content = await Deno.readTextFile(fromFileUrl(resolvedUrl));
      c.header("Content-Type", "application/javascript; charset=utf-8");
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.body(content);
    } else {
      const response = await fetch(resolvedUrl);
      if (!response.ok) return next();
      c.header("Content-Type", "application/javascript; charset=utf-8");
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return c.body(await response.text());
    }
  };
}

/**
 * Create a feature middleware that adds a flag to the tinyToolsFeatures set.
 * @internal
 */
function createFeatureMiddleware(featureName: string): MiddlewareHandler {
  return async (c, next) => {
    const features = c.get("tinyToolsFeatures") as Set<string> | undefined;
    if (features) {
      features.add(featureName);
    }
    await next();
  };
}

function createSseFeatureMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const features = c.get("tinyToolsFeatures") as Set<string> | undefined;
    if (features) {
      features.add("sse");
    }
    await trackConnectedClients(c, next);
  };
}

function isImmutablePublicAssetPath(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const relativePath = normalizedPath.startsWith("public/")
    ? normalizedPath.slice("public/".length)
    : normalizedPath.startsWith("/")
    ? normalizedPath.slice(1)
    : normalizedPath;

  return relativePath.startsWith("handlers/") ||
    relativePath.startsWith("styles/");
}

function isLikelyAssetRequestPath(path: string): boolean {
  const normalizedPath = path.split("?")[0]?.split("#")[0] ?? "";
  const segments = normalizedPath.split("/");
  if (segments.includes("api")) return false;
  const lastSegment = segments.at(-1) ?? "";
  return /\.[a-z0-9]{1,8}$/i.test(lastSegment);
}

/**
 * Create the core middleware array.
 * Sets up static file serving, context storage, tools tracking, and JSX rendering.
 * @internal
 */
function createCoreMiddleware(
  options: ClientToolsOptions = {},
): MiddlewareHandler[] {
  if (options.generatedFilenameHashLength !== undefined) {
    setGeneratedFilenameHashLength(options.generatedFilenameHashLength);
  }
  if (options.generatedHandlerHashLength !== undefined) {
    setGeneratedHandlerHashLength(options.generatedHandlerHashLength);
  }
  if (options.generatedStyleHashLength !== undefined) {
    setGeneratedStyleHashLength(options.generatedStyleHashLength);
  }

  performance.mark("startup:appCreated");

  return [
    // Serve package client JS files from /_tinytools/
    servePackageClientFiles(),
    // Static file serving for user's public directory with aggressive caching for content-hashed files
    serveStatic({
      root: "./public/",
      onFound: (path, c) => {
        // Handler files (public/handlers/*.js) and style files (public/styles/*.css)
        // have content-hashed filenames, so they're immutable and can be cached forever
        if (isImmutablePublicAssetPath(path)) {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
      onNotFound: (path, c) => {
        if (isImmutablePublicAssetPath(path)) {
          console.error(`Handler or style file not found: ${path}`);
        }

        if (isLikelyAssetRequestPath(c.req.path)) {
          throw new HTTPException(404);
        }
      },
    }),

    // Context storage for getContext() in async components
    contextStorage(),
    // Initialize empty tools with tracking infrastructure
    createToolsMiddleware(),
    // JSX renderer with AssetTags (features are read from context by AssetTags)
    jsxRenderer(async (
      { children, title },
      c,
    ) => {
      console.log(
        "Rendering page with jsx renderer for layout, title: ",
        title,
      );
      const evaluatedBody = await children;
      const routeLayoutApplied = c.get(ROUTE_LAYOUT_APPLIED_KEY) === true;

      const sourceUrl = c.req.header("source-url");
      console.log("Source URL: ", sourceUrl);
      if (sourceUrl) {
        return (
          <update>
            <template>
              <head-update>
                <AssetTags fullPageLoad={false} />
              </head-update>
              <body-update>{evaluatedBody}</body-update>
            </template>
          </update>
        );
      }

      const url = new URL(c.req.url);
      const urlPathVars = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part, i) => `--path-${i}: ${part};`);
      const urlQueryVars = Array.from(url.searchParams.entries())
        .map(([key, value]) => `--param-${key}: ${value};`);

      return (
        <html style={[...urlPathVars, ...urlQueryVars].join(" ")}>
          <head>
            <title>{title}</title>
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
            <style>
              @layer global, unscoped, limited, normal, important, debug;
            </style>
            <AssetTags />
          </head>
          {routeLayoutApplied ? evaluatedBody : <body>{evaluatedBody}</body>}
        </html>
      );
    }, {
      stream: true,
      docType: true,
    }),
  ];
}

// ============================================================================
// tiny - Pre-built singleton with composable middleware
// ============================================================================

/**
 * TinyTools middleware API.
 *
 * Provides opt-in middleware for enhancing Hono apps with client-side tools,
 * SPA navigation, SSE, local routes, web components, and route layouts.
 *
 * @example Granular opt-in
 * ```ts
 * import { Hono } from "hono";
 * import { tiny, ClientTools, css } from "@tinytools/hono-tools";
 *
 * const app = new Hono()
 *   .use(...tiny.middleware.core({ generatedStyleHashLength: 4 }))
 *   .use(tiny.middleware.navApiTools())
 *   .use(tiny.middleware.sseTools())
 *   .use(tiny.middleware.layout(MyLayout))
 * ```
 *
 * @example Complete mode (all features)
 * ```ts
 * const app = new Hono()
 *   .use(...tiny.middleware.all({ generatedStyleHashLength: 4 }))
 *   .use(tiny.middleware.layout(MyLayout))
 * ```
 *
 * @example Minimal (client tools only, no SPA features)
 * ```ts
 * const app = new Hono()
 *   .use(...tiny.middleware.core())
 *   .use(tiny.middleware.layout(MyLayout))
 * ```
 */
export const tiny = {
  Handlers,
  Styles,
  css,
  imports: importTools,
  middleware: {
    /**
     * Core middleware that sets up static file serving, context storage,
     * tools tracking, and JSX rendering. Required as the foundation for all
     * other tiny middleware.
     *
     * Returns an array of middleware handlers (use spread operator).
     *
     * @param options - Optional configuration for hash lengths
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core({ generatedStyleHashLength: 4 }))
     * ```
     */
    core(options?: ClientToolsOptions): MiddlewareHandler[] {
      return createCoreMiddleware(options);
    },

    /**
     * Add one or more global style assets to every request so AssetTags always
     * includes their CSS files.
     *
     * Use this with styles defined using the `globalStyles` option in ClientTools.
     *
     * @param styles - One or more global styles from `tools.globalStyles`
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.sharedImports(tools))
     * ```
     */
    sharedImports: createSharedImportsMiddleware,

    /**
     * Add one or more global style assets to every request so AssetTags always
     * includes their CSS files.
     *
     * Use this with styles defined using the `globalStyles` option in ClientTools.
     *
     * @param styles - One or more global styles from `tools.globalStyles`
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.sharedImports(tools))
     *   .use(tiny.middleware.globalStyles(...tools.globalStyles))
     * ```
     */
    globalStyles(...styles: { filename: string }[]): MiddlewareHandler {
      return addGlobalStyles(...styles);
    },

    /**
     * Enable SPA navigation with partial page updates and lazy event handler loading.
     *
     * Adds client scripts: navigation.js, processIncomingData.js,
     * processIncomingHtml.js, performFetchAndUpdate.js, eventHandlers.js
     *
     * @param _options - Reserved for future use
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.navApiTools())
     * ```
     */
    navApiTools(_options?: NavApiToolsOptions): MiddlewareHandler {
      return createFeatureMiddleware("navigation");
    },

    /**
     * Enable Server-Sent Events for live updates from the server.
     *
     * Adds client script: sse.js and request middleware that tracks SSE client
     * identity and recent route paths.
     *
     * @param _options - Reserved for future use
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.sseTools())
     * ```
     */
    sseTools(_options?: SseToolsOptions): MiddlewareHandler {
      return createSseFeatureMiddleware();
    },

    /**
     * Enable client-side template routing.
     *
     * Adds client script: localRoutes.js
     *
     * @param _options - Reserved for future use
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.localRoutes())
     * ```
     */
    localRoutes(_options?: LocalRoutesOptions): MiddlewareHandler {
      return createFeatureMiddleware("localRoutes");
    },

    /**
     * Enable web component scripts (lifecycle-element, window-event-listener).
     *
     * Adds client scripts: wc-lifecycleElement.js, wc-windowEventlistener.js
     *
     * @param _options - Reserved for future use
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.webComponents())
     * ```
     */
    webComponents(_options?: WebComponentsOptions): MiddlewareHandler {
      return createFeatureMiddleware("webComponents");
    },

    /**
     * Create a middleware that wraps routes with a layout component.
     * Handles partial navigation (source-url header) by returning children directly,
     * otherwise wraps children in the provided layout component.
     *
     * The layout is rendered once as a dummy (with empty fragment) to register
     * any tools/styles before the actual render.
     *
     * @param LayoutComponent - A JSX component that receives children and context
     *
     * @example With a simple component
     * ```tsx
     * const MyLayout = ({ children }: { children: Child }) => (
     *   <TwoColumnSplit contentPanelChildren={children}>
     *     <nav>Sidebar</nav>
     *   </TwoColumnSplit>
     * );
     *
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.layout(MyLayout))
     * ```
     *
     * @example With inline JSX function
     * ```tsx
     * const app = new Hono()
     *   .use(...tiny.middleware.core())
     *   .use(tiny.middleware.layout(({ children }, c) => (
     *     <TwoColumnSplit contentPanelChildren={children}>
     *       <nav>Sidebar</nav>
     *     </TwoColumnSplit>
     *   )))
     * ```
     */
    layout: addRouteLayout,

    /**
     * Enable all features: navigation, SSE, local routes, and web components.
     *
     * Returns an array of middleware handlers (use spread operator).
     * Equivalent to using core() + navApiTools() + sseTools() +
     * localRoutes() + webComponents() individually.
     *
     * @param options - Optional configuration for hash lengths (passed to core)
     *
     * @example
     * ```ts
     * const app = new Hono()
     *   .use(...tiny.middleware.all({ generatedStyleHashLength: 4 }))
     *   .use(tiny.middleware.layout(MyLayout))
     * ```
     */
    all(options?: ClientToolsOptions): MiddlewareHandler[] {
      return [
        ...createCoreMiddleware(options),
        createFeatureMiddleware("navigation"),
        createSseFeatureMiddleware(),
        createFeatureMiddleware("localRoutes"),
        createFeatureMiddleware("webComponents"),
      ];
    },
  },
} as const;
