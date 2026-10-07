/** Hono middleware and request rendering for TinyTools. */
import { component, transparent } from "./componentScope.ts";
import { Hono as HonoBase } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { BlankEnv, Env } from "hono/types";
import type { HonoOptions } from "hono/hono-base";
import { HTTPException } from "hono/http-exception";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { contextStorage } from "hono/context-storage";
import { jsxRenderer } from "hono/jsx-renderer";

import {
  Constants,
  Handlers,
  imports,
  memoryAssets,
  memoryBuild,
  setGeneratedFilenameHashLength,
  setGeneratedHandlerHashLength,
  setGeneratedStyleHashLength,
  Signals,
  Store,
  Styles,
  Templates,
} from "./clientTools.ts";
import { getContextTitle } from "./titled.ts";
import { css } from "./scopedStyles.ts";
import { AssetTags, LifecycleTags } from "./components/AssetTags.tsx";
import {
  defineLifecycleElement,
  defineLifecycleTags,
} from "./lifecycleElement.ts";
import { NewPartial } from "./components/NewPartial.tsx";
import { CSP_ENABLED_KEY, eventHandlerBody } from "./eventAttributes.ts";

const ROUTE_LAYOUT_APPLIED_KEY = "tinyToolsRouteLayoutApplied";
/**
 * The inline head script: the handler dispatcher and the lifecycle element
 * runtime, which defines the tags declared by `<meta name="tt-define">`
 * before the body is parsed. Exported for tests that check the CSP hash.
 */
export const runHandlerScript = [
  runHandler.toString(),
  defineLifecycleElement.toString(),
  defineLifecycleTags.toString(),
  "defineLifecycleTags();",
  "const tiny = {runHandler, defineLifecycleElement};",
].join("\n");

export type RouteLayoutProps = { children: Child };
/** A layout callback; it may return the children unchanged. */
export type RouteLayoutComponent = (
  props: RouteLayoutProps,
  context: Context,
) => Child | Promise<Child>;

function createRouteLayout(
  LayoutComponent: RouteLayoutComponent,
  renderOnPartial: boolean,
): MiddlewareHandler {
  // deno-lint-ignore no-explicit-any
  return jsxRenderer(async ({ children, Layout, title }: any, context) => {
    const partialNavigation = !!context.req.header("source-url");
    if (!partialNavigation) context.set(ROUTE_LAYOUT_APPLIED_KEY, true);
    await children;
    return (
      <Layout title={title}>
        {partialNavigation && !renderOnPartial
          ? children
          : LayoutComponent({ children }, context)}
      </Layout>
    );
  }, { stream: true });
}

export type ClientToolsOptions = {
  /** Enable CSP and JSX reference transforms. Defaults to true. */
  csp?: boolean;
  /** Generated filename hash length, clamped to 1-8. */
  generatedFilenameHashLength?: number;
  generatedHandlerHashLength?: number;
  generatedStyleHashLength?: number;
  /** Runtime-specific static serving adapter; auto-detected when omitted. */
  // deno-lint-ignore no-explicit-any
  serveStatic?: (options: any) => MiddlewareHandler;
};

function createCspMiddleware(): MiddlewareHandler {
  const policy = Promise.all(
    [runHandlerScript, eventHandlerBody].map(async (source) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(source),
      );
      return btoa(String.fromCharCode(...new Uint8Array(digest)));
    }),
  ).then(([scriptHash, eventHash]) => {
    return `script-src 'self' 'sha256-${scriptHash}'; script-src-attr 'unsafe-hashes' 'sha256-${eventHash}'`;
  });
  return async (context, next) => {
    await next();
    context.header("Content-Security-Policy", await policy);
  };
}

async function resolveRendererChildren(children: Child): Promise<string> {
  try {
    const resolved = await children;
    return resolved == null || typeof resolved === "boolean"
      ? ""
      : await resolved.toString();
  } catch (error) {
    if (error instanceof Promise) {
      await error;
      return resolveRendererChildren(children);
    }
    throw error;
  }
}

async function detectServeStatic(): Promise<
  NonNullable<ClientToolsOptions["serveStatic"]>
> {
  try {
    return (await import("hono/deno")).serveStatic;
  } catch { /* not available */ }
  try {
    return (await import("hono/bun")).serveStatic;
  } catch { /* not available */ }
  try {
    // deno-lint-ignore no-explicit-any
    return (await import("@hono/node-server/serve-static" as any)).serveStatic;
  } catch { /* not available */ }
  throw new Error(
    "[tiny-tools] No serveStatic adapter found. " +
      "Pass serveStatic in options: tiny.middleware.core({ serveStatic })",
  );
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
  return /\.[a-z0-9]{1,8}$/i.test(segments.at(-1) ?? "");
}

/** Handlers for the `<update>` head section of partial responses. */
export const headHandler = new Handlers(import.meta.url, {
  /** Moves the template's title, scripts and stylesheets into `<head>`, waiting for new stylesheets. */
  importIntoHead: async function (this: HTMLTemplateElement) {
    const head = this.content;
    if (head) {
      await Promise.all(
        Array.from(head.children).map((child) => {
          if (child.tagName === "TITLE") {
            globalThis.document.title = child.textContent ?? "";
            return;
          }
          if (child instanceof HTMLScriptElement && child.src) {
            const srcAttr = child.getAttribute("src");
            if (
              globalThis.document.head.querySelector(`script[src="${srcAttr}"]`)
            ) return;
          } else if (
            child instanceof HTMLLinkElement && child.rel === "stylesheet" &&
            child.href
          ) {
            const hrefAttr = child.getAttribute("href");
            if (
              globalThis.document.head.querySelector(
                `link[rel="stylesheet"][href="${hrefAttr}"]`,
              )
            ) return;
            return new Promise<void>((resolve, reject) => {
              child.onload = () => resolve();
              child.onerror = () =>
                reject(new Error(`Failed to load stylesheet: ${hrefAttr}`));
              globalThis.document.head.appendChild(child);
            });
          }
          globalThis.document.head.appendChild(child);
        }),
      );
      this.remove();
    }
  },
  /** Appends a partial response's body (templates and their triggers) to the document. */
  cacheRoute: function (this: HTMLTemplateElement) {
    for (const child of Array.from(this.content.children)) {
      document.body.appendChild(child);
    }
    this.remove();
  },
});

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
  let staticMiddleware: MiddlewareHandler | undefined;
  return [
    async (context, next) => {
      context.set(CSP_ENABLED_KEY, options.csp !== false);
      await next();
    },
    ...(options.csp === false ? [] : [createCspMiddleware()]),
    async (context, next) => {
      if (memoryBuild && /^\/(handlers|styles)\//.test(context.req.path)) {
        const content = memoryAssets.get(context.req.path);
        if (content === undefined) return context.notFound();
        context.header(
          "Content-Type",
          context.req.path.startsWith("/handlers/")
            ? "application/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
        );
        context.header("Cache-Control", "public, max-age=31536000, immutable");
        return context.body(content);
      }
      if (!staticMiddleware) {
        const serveStatic = options.serveStatic ?? await detectServeStatic();
        staticMiddleware = serveStatic({
          root: "./public/",
          onFound: (path: string, context: Context) => {
            if (isImmutablePublicAssetPath(path)) {
              context.header(
                "Cache-Control",
                "public, max-age=31536000, immutable",
              );
            }
          },
          onNotFound: (path: string, context: Context) => {
            if (isImmutablePublicAssetPath(path)) {
              console.error(`Handler or style file not found: ${path}`);
            }
            if (isLikelyAssetRequestPath(context.req.path)) {
              throw new HTTPException(404);
            }
          },
        });
      }
      return staticMiddleware(context, next);
    },
    contextStorage(),
    async (context, next) => {
      context.set("accessedHandlerFiles", new Set<string>());
      context.set("accessedStyleFiles", new Set<string>());
      context.set("accessedLifecycleTags", new Set<string>());
      await next();
    },
    // deno-lint-ignore no-explicit-any
    jsxRenderer(async ({ children, title }: any, context) => {
      title ??= getContextTitle(context);
      const routeLayoutApplied = context.get(ROUTE_LAYOUT_APPLIED_KEY) === true;
      const { fn } = await imports(headHandler);
      const evaluatedChildren = await children;
      const evaluatedBody = await resolveRendererChildren(evaluatedChildren);
      const callbackChildren = evaluatedChildren as string & {
        callbacks?: Parameters<typeof raw>[1];
      };
      const callbackBody = evaluatedBody as string & {
        callbacks?: Parameters<typeof raw>[1];
      };
      const callbacks = Array.from(
        new Set([
          ...(callbackChildren?.callbacks ?? []),
          ...(callbackBody.callbacks ?? []),
        ]),
      );
      const escapedBody = raw(callbackBody, callbacks);
      const body = callbacks.length
        ? Promise.resolve(escapedBody)
        : escapedBody;
      const accessedHandlerFiles = context.get("accessedHandlerFiles") as Set<
        string
      >;
      const accessedStyleFiles = context.get("accessedStyleFiles") as Set<
        string
      >;
      const accessedLifecycleTags = context.get("accessedLifecycleTags") as Set<
        string
      >;
      const handlerFiles = Array.from(accessedHandlerFiles);
      const styleFiles = Array.from(accessedStyleFiles);
      const lifecycleTags = Array.from(accessedLifecycleTags);
      accessedHandlerFiles.clear();
      accessedStyleFiles.clear();
      accessedLifecycleTags.clear();
      if (context.req.header("source-url")) {
        // Tag declarations sit at the top level, so they connect (and define)
        // in the same append as the templates, before any trigger fires.
        return (
          <update>
            <LifecycleTags tags={lifecycleTags} />
            <NewPartial onLoad={fn.importIntoHead}>
              {title !== undefined && <title>{title}</title>}
              <AssetTags
                accessedHandlerFiles={handlerFiles}
                accessedStyleFiles={styleFiles}
              />
            </NewPartial>
            <NewPartial onLoad={fn.cacheRoute}>{body}</NewPartial>
          </update>
        );
      }
      return (
        <html>
          <head>
            <title>{title}</title>
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
            <style>
              @layer global, unscoped, limited, normal, important, debug;
            </style>
            <AssetTags
              accessedHandlerFiles={handlerFiles}
              accessedStyleFiles={styleFiles}
              accessedLifecycleTags={lifecycleTags}
              defineWith="meta"
            />
            <script>{raw(runHandlerScript)}</script>
          </head>
          {routeLayoutApplied ? body : <body>{body}</body>}
        </html>
      );
    }, { stream: true, docType: true }),
  ];
}

export type TinyHonoOptions<E extends Env = BlankEnv> =
  & HonoOptions<E>
  & ClientToolsOptions
  & { tools?: "core" };

class TinyHono<E extends Env = BlankEnv> extends HonoBase<E> {
  constructor(options: TinyHonoOptions<E> = {} as TinyHonoOptions<E>) {
    const {
      tools,
      csp,
      serveStatic,
      generatedFilenameHashLength,
      generatedHandlerHashLength,
      generatedStyleHashLength,
      ...honoOptions
    } = options;
    super(honoOptions as HonoOptions<E>);
    if (tools) {
      for (
        const middleware of createCoreMiddleware({
          csp,
          serveStatic,
          generatedFilenameHashLength,
          generatedHandlerHashLength,
          generatedStyleHashLength,
        })
      ) this.use(middleware);
    }
  }
}

/**
 * Runs the handlers named by the element's `tt-handler-<event.type>` attribute.
 * Loaded bundles register themselves on `globalThis.handlers`, so their
 * handlers run synchronously during dispatch (needed for `preventDefault()`,
 * `NavigateEvent.intercept()` and the like). A bundle that has not loaded yet
 * is imported, and its handler runs once it has. Handlers run in the order
 * listed: once one waits for its bundle, the ones after it wait too.
 */
export function runHandler(
  el: HTMLElement | typeof globalThis,
  e: Event,
) {
  const element = el === globalThis ? document.body : el as HTMLElement;
  type Bundle = Record<string, (this: unknown, event: Event) => unknown>;
  const registered = (name: string): Bundle | undefined =>
    (globalThis as { handlers?: Record<string, Bundle> }).handlers?.[name];

  // Set once a handler has to wait for its bundle; later handlers in the
  // list queue behind it, so they run in the attribute's order.
  let pending: Promise<unknown> | undefined;

  // Each reference is `<bundle>.<handler>`.
  for (
    const reference of (element.getAttribute("tt-handler-" + e.type) ?? "")
      .split(" ")
  ) {
    const dot = reference.indexOf(".");
    if (dot < 1) continue;
    const name = reference.slice(0, dot);
    const handler = reference.slice(dot + 1);
    const run = (bundle: Bundle) => {
      if (typeof bundle[handler] !== "function") {
        console.error(`Handler ${reference} not found in its bundle.`);
        return;
      }
      bundle[handler].call(el, e);
    };
    const bundle = registered(name);
    if (bundle && !pending) {
      run(bundle);
      continue;
    }
    // Re-checked at run time: an earlier link may have loaded this bundle.
    const load = () => registered(name) ?? import(`/handlers/${name}.js`);
    pending = (pending ? pending.then(load) : Promise.resolve(load()))
      .then(run)
      .catch((error) => console.error(`Handler ${reference} failed:`, error));
  }
}

export type TinyApi = {
  readonly Hono: typeof TinyHono;
  readonly Handlers: typeof Handlers;
  readonly Constants: typeof Constants;
  /** @deprecated Use tiny.Signals instead. Retained for compatibility. */
  readonly Store: typeof Store;
  readonly Signals: typeof Signals;
  readonly Templates: typeof Templates;
  readonly runHandler: typeof runHandler;
  /** Defines a custom tag as a lifecycle element; in the browser, the inline head runtime. */
  readonly defineLifecycleElement: typeof defineLifecycleElement;
  readonly Styles: typeof Styles;
  readonly css: typeof css;
  readonly imports: typeof imports;
  readonly component: typeof component;
  readonly transparent: typeof transparent;
  readonly middleware: {
    readonly core: (options?: ClientToolsOptions) => MiddlewareHandler[];
    readonly csp: () => MiddlewareHandler;
    readonly layout: (component: RouteLayoutComponent) => MiddlewareHandler;
    readonly partialLayout: (
      component: RouteLayoutComponent,
    ) => MiddlewareHandler;
  };
  readonly build: (
    options?: import("./build.ts").BuildOptions,
  ) => Promise<void>;
};

export const tiny: TinyApi = {
  Hono: TinyHono,
  Handlers,
  Constants,
  Store,
  Signals,
  Templates,
  Styles,
  css,
  imports,
  component,
  transparent,
  runHandler,
  defineLifecycleElement,
  middleware: {
    core: createCoreMiddleware,
    csp: createCspMiddleware,
    layout: (component) => createRouteLayout(component, false),
    partialLayout: (component) => createRouteLayout(component, true),
  },
  async build(options) {
    const { buildScriptFiles } = await import("./build.ts");
    await buildScriptFiles(options);
  },
};
