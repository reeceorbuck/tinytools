/**
 * Static site generation: renders every page of an app to HTML files, beside
 * the handler, style and runtime files they load, for hosting without a
 * server.
 *
 * @module
 */

import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { Hono } from "hono";
import { type BuildOptions, buildScriptFiles } from "./build.ts";
import { memoryAssets, memoryBuild } from "./clientTools.ts";
import { getEsbuild } from "./esbuildInit.ts";
import { runHandlerScript, runtimeScriptPath } from "./honoFactory.tsx";
import { lifecycleRuntimeFiles } from "./lifecycleElement.ts";
import { signalRuntimeFiles } from "./signalModules.ts";

/**
 * The env key Hono's SSG helpers read, so `ssgParams`, `disableSSG`,
 * `onlySSG` and `isSSGContext` from `hono/ssg` work on routes built here.
 */
const SSG_CONTEXT = "HONO_SSG_CONTEXT";
const DISABLE_SSG_HEADER = "x-hono-disable-ssg";
/**
 * A path no page has: requested to render the app's not-found page as
 * `404.html`, and sent as every partial's `source-url`. A static partial
 * serves navigations from every page, so it is rendered as if from outside
 * the site: routes that send less when the source is close by (a section
 * layout already on the page) send all of it.
 */
const OUTSIDE_PATH = "/__tinytools_static_outside__";

/**
 * The meta tag a static page carries so partial navigation fetches each
 * page's partial from a file under its prefix (see `navigationTools`).
 */
export const STATIC_PARTIALS_META = "tt-partials";

/** Options for `buildStaticSite`. `BuildOptions` configure the asset build. */
export interface StaticSiteOptions extends BuildOptions {
  /** Output directory, emptied first. Defaults to `./dist`. */
  outDir?: string;
  /**
   * The origin pages are rendered at, so `c.req.url` and URLs made from it
   * point at the live site. Defaults to `http://localhost`.
   */
  origin?: string;
  /**
   * Paths to render besides the app's GET routes, such as each value of a
   * dynamic route. Routes may also list theirs with `ssgParams` from
   * `hono/ssg`.
   */
  paths?: Iterable<string>;
  /** Also render same-origin pages linked from rendered pages. Defaults to true. */
  crawl?: boolean;
  /** URL prefix partial pages are written under. Defaults to `/_partials`. */
  partialsPath?: string;
  /**
   * Copy each page's Content-Security-Policy header into a `<meta>` tag,
   * since static hosts do not send it. Defaults to true.
   */
  cspMeta?: boolean;
}

/** What `buildStaticSite` wrote. */
export interface StaticSiteResult {
  /** The paths rendered as pages. */
  pages: string[];
  /** Every file written, relative to the output directory. */
  files: string[];
}

/** The file a page path is written to: `/` is `/index.html`, `/a` is `/a.html`. */
export function staticPageFile(pathname: string): string {
  const path = decodeURIComponent(pathname);
  if (path.endsWith("/")) return `${path}index.html`;
  return `${path}.html`;
}

type App = Pick<Hono, "routes" | "fetch">;

/** Unwraps `app.route()`'s composed handlers, as Hono's SSG helper does. */
function targetHandler(handler: unknown): { length: number } {
  const composed = (handler as { __COMPOSED_HANDLER?: unknown })
    .__COMPOSED_HANDLER;
  return composed ? targetHandler(composed) : handler as { length: number };
}

function isDynamicRoute(path: string): boolean {
  return path.split("/").some((segment) =>
    segment.startsWith(":") || segment.includes("*")
  );
}

function fillRoute(path: string, params: Record<string, string>): string {
  const filled = path.replace(
    /:([^/{?]+)(\{[^}]*\})?\??/g,
    (_, name: string) => encodeURIComponent(params[name] ?? ""),
  ).replace(/\/+/g, "/");
  return filled.length > 1 ? filled.replace(/\/$/, "") : filled;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** Same-origin page paths linked from `html` with `<a href>`. */
function linkedPaths(html: string, pageUrl: URL): string[] {
  const paths: string[] = [];
  for (const [, href] of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)) {
    let url: URL;
    try {
      url = new URL(href.replaceAll("&amp;", "&"), pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== pageUrl.origin) continue;
    // Files are copied from the public directory, not rendered.
    if (extname(url.pathname)) continue;
    paths.push(url.pathname);
  }
  return paths;
}

function redirectPage(location: string): string {
  const href = escapeAttribute(location);
  return `<!DOCTYPE html><title>Redirecting</title>` +
    `<meta http-equiv="refresh" content="0;url=${href}">` +
    `<meta name="robots" content="noindex"><link rel="canonical" href="${href}">` +
    `<a href="${href}">Redirecting to ${href}</a>`;
}

/**
 * Renders `app` to a static site: an HTML file for every page, a partial for
 * each that partial navigation fetches in place of a server's partial
 * response, the app's not-found page as `404.html`, and every handler,
 * style, runtime and public file they load.
 *
 * Pages are the app's GET routes, the `paths` given, and (with `crawl`)
 * every same-origin page they link to. Each is requested like a browser
 * would, so only content that does not depend on the request (cookies,
 * query strings, POST handlers, server-sent events) carries over. Routes
 * can opt out with `disableSSG()` from `hono/ssg`.
 *
 * Run it in its own process, after importing the app, as `buildScriptFiles`
 * is:
 *
 * @example
 * ```ts
 * import { buildStaticSite } from "tinytools/build";
 * import { app } from "./main.tsx";
 *
 * await buildStaticSite(app, { origin: "https://example.com" });
 * ```
 */
export async function buildStaticSite(
  app: App,
  options: StaticSiteOptions = {},
): Promise<StaticSiteResult> {
  const {
    outDir = "./dist",
    origin = "http://localhost",
    paths = [],
    crawl = true,
    partialsPath = "/_partials",
    cspMeta = true,
    ...buildOptions
  } = options;
  const publicDir = buildOptions.publicDir ?? "./public";
  const outPath = resolve(outDir);
  const publicPath = resolve(publicDir);
  if (
    outPath === resolve(".") || !relative(outPath, publicPath).startsWith("..")
  ) {
    throw new Error(
      `[tiny-tools] outDir ${outDir} would replace the project or its public directory.`,
    );
  }
  const partialsPrefix = `/${partialsPath.replace(/^\/+|\/+$/g, "")}`;

  if (!memoryBuild) await buildScriptFiles(buildOptions);

  /** Rendered output, by path below `outDir`; written after the public copy. */
  const output = new Map<string, string>();
  const rendered: string[] = [];
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueue = (path: string) => {
    if (queued.has(path)) return;
    queued.add(path);
    queue.push(path);
  };

  const request = async (path: string, partial: boolean) => {
    const req = new Request(new URL(path, origin), {
      headers: partial
        ? {
          "partial-nav": "true",
          "source-url": OUTSIDE_PATH,
          "destination-url": path,
        }
        : {},
    }) as Request & { ssgParams?: Record<string, string>[] };
    const response = await app.fetch(req, { [SSG_CONTEXT]: true });
    return { req, response };
  };

  for (const { method, handler, path } of app.routes) {
    if (method !== "GET" && method !== "ALL") continue;
    // Middleware takes `next`; routes do not.
    if (targetHandler(handler).length > 1) continue;
    if (!isDynamicRoute(path)) {
      enqueue(path);
      continue;
    }
    const { req, response } = await request(path, false);
    await response.body?.cancel();
    for (const params of req.ssgParams ?? []) {
      enqueue(fillRoute(path, params));
    }
  }
  for (const path of paths) enqueue(path);

  const withHeadMeta = (html: string, response: Response) => {
    const csp = cspMeta && response.headers.get("Content-Security-Policy");
    const meta = [
      ...(csp
        ? [
          `<meta http-equiv="Content-Security-Policy" content="${
            escapeAttribute(csp)
          }">`,
        ]
        : []),
      `<meta name="${STATIC_PARTIALS_META}" content="${partialsPrefix}">`,
    ].join("");
    return html.replace(/<head(\s[^>]*)?>/i, (head) => head + meta);
  };

  while (queue.length > 0) {
    const path = queue.shift()!;
    const { response } = await request(path, false);
    if (response.headers.get(DISABLE_SSG_HEADER)) {
      await response.body?.cancel();
      continue;
    }
    const location = response.headers.get("Location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      output.set(staticPageFile(path), redirectPage(location));
      const target = new URL(location, new URL(path, origin));
      if (target.origin === new URL(origin).origin) enqueue(target.pathname);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      console.warn(
        `[tiny-tools] Skipped ${path}: the app answered ${response.status}.`,
      );
      continue;
    }
    const type = response.headers.get("Content-Type") ?? "";
    if (!type.startsWith("text/html")) {
      // A non-page route, such as /robots.txt or /feed.xml, keeps its path.
      if (extname(path)) output.set(path, await response.text());
      else {
        await response.body?.cancel();
        console.warn(
          `[tiny-tools] Skipped ${path}: ${
            type || "no content type"
          } needs a file extension in its path.`,
        );
      }
      continue;
    }
    const html = await response.text();
    output.set(staticPageFile(path), withHeadMeta(html, response));
    rendered.push(path);
    if (crawl) {
      for (const linked of linkedPaths(html, new URL(path, origin))) {
        enqueue(linked);
      }
    }
    const partial = await request(path, true);
    output.set(
      `${partialsPrefix}${staticPageFile(path)}`,
      await partial.response.text(),
    );
  }

  // `app.notFound` answers with whatever status its handler sets.
  const notFound = await request(OUTSIDE_PATH, false);
  if (
    [200, 404].includes(notFound.response.status) &&
    notFound.response.headers.get("Content-Type")?.startsWith("text/html")
  ) {
    output.set(
      "/404.html",
      withHeadMeta(await notFound.response.text(), notFound.response),
    );
  } else await notFound.response.body?.cancel();

  // Served from memory by `tiny.middleware.core()`, so written here.
  output.set(runtimeScriptPath(), runHandlerScript);
  for (
    const files of [lifecycleRuntimeFiles, signalRuntimeFiles, memoryAssets]
  ) {
    for (const [path, content] of files) output.set(path, content);
  }

  await rm(outPath, { recursive: true, force: true });
  await mkdir(outPath, { recursive: true });
  if (await stat(publicPath).then((s) => s.isDirectory(), () => false)) {
    await cp(publicPath, outPath, { recursive: true });
  }
  for (const [path, content] of output) {
    const file = join(outPath, path);
    if (!resolve(file).startsWith(outPath)) {
      throw new Error(`[tiny-tools] ${path} is outside the output directory.`);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const files: string[] = [];
  for (const path of await readdir(outPath, { recursive: true })) {
    if ((await stat(join(outPath, path))).isFile()) {
      files.push(path.replaceAll("\\", "/"));
    }
  }

  if (memoryBuild) await (await getEsbuild()).stop();
  console.log(
    `Static site written to ${outDir}: ${rendered.length} pages, ${files.length} files.`,
  );
  return { pages: rendered, files };
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/**
 * A fetch handler that serves a `buildStaticSite` output directory the way
 * a static host does: `/a` from `a.html`, `/a/` from `a/index.html`, and
 * `404.html` for anything missing. For previewing a build locally:
 * `Deno.serve(staticSiteFetch("./dist"))`.
 */
export function staticSiteFetch(
  outDir = "./dist",
): (request: Request) => Promise<Response> {
  const root = resolve(outDir);
  const read = async (path: string) => {
    const file = resolve(join(root, path));
    if (!file.startsWith(root)) return undefined;
    const body = await readFile(file).catch(() => undefined);
    return body && new Uint8Array(body);
  };
  return async (request) => {
    const { pathname } = new URL(request.url);
    const path = extname(pathname)
      ? decodeURIComponent(pathname)
      : staticPageFile(pathname);
    const body = await read(path);
    if (body) {
      return new Response(body, {
        headers: {
          "Content-Type": contentTypes[extname(path)] ??
            "application/octet-stream",
        },
      });
    }
    const notFound = await read("/404.html");
    return new Response(notFound ?? "Not Found", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
}
