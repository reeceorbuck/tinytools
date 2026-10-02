/**
 * Suspense Component for @tinytools/hono-tools
 *
 * Custom streaming module based on Hono's streaming.ts
 * This module enables JSX to support streaming Response with partial updates.
 *
 * @module
 */

import { raw } from "hono/html";
import { HtmlEscapedCallbackPhase, resolveCallback } from "hono/utils/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { getContext } from "hono/context-storage";
import { tiny } from "@tinytools/hono-tools";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";
import { headHandler } from "../honoFactory.tsx";
import { NewPartial } from "./NewPartial.tsx";
import { renderToReadableStream } from "hono/jsx/dom/server";
import { AssetTags } from "./AssetTags.tsx";
import { transparent } from "../componentScope.ts";

export type PartialInsertHandler = Parameters<typeof NewPartial>[0]["onLoad"];

export type SuspenseProps = PropsWithChildren<{
  // deno-lint-ignore no-explicit-any
  fallback: any;
}>;

export type CustomSuspenseProps = SuspenseProps & {
  onLoad: PartialInsertHandler;
};

const childToString = (child: Child): string | Promise<string> => {
  if (child instanceof Promise) {
    return child.then(childToString);
  }
  if (child == null || typeof child === "boolean") {
    return "";
  }
  if (child instanceof String) {
    return child as HtmlEscapedString;
  }
  return child.toString();
};

const childrenToString = async (
  children: Child[],
): Promise<HtmlEscapedString[]> => {
  try {
    return await Promise.all(
      children.flat().map(childToString),
    ) as HtmlEscapedString[];
  } catch (e) {
    if (e instanceof Promise) {
      await e;
      return childrenToString(children);
    } else {
      throw e;
    }
  }
};

// Internal Hono types - inlined since they're not exported publicly
const DOM_STASH = Symbol.for("STASH");

type NodeObject = {
  [DOM_STASH]: [number, unknown[]];
};

// We need to track build data stack ourselves
const buildDataStack: [unknown[], NodeObject][] = [];

let suspenseCounter = 0;

/**
 * Suspense component for streaming content with fallback.
 *
 * Shows a fallback while async children are loading, then streams
 * the real content when ready. Integrates with the partial update
 * system to replace the fallback in-place.
 *
 * @experimental This is an experimental feature. The API might change.
 *
 * @example
 * ```tsx
 * import { Suspense } from "@tinytools/hono-tools/components";
 *
 * app.get("/dashboard", (c) => {
 *   return c.render(
 *     <Suspense fallback={<LoadingSpinner />}>
 *       <AsyncDashboardData />
 *     </Suspense>
 *   );
 * });
 * ```
 */
export const CustomSuspense: FC<CustomSuspenseProps> = async ({
  children,
  fallback,
  onLoad,
}) => {
  if (!children) {
    return fallback?.toString() ?? "";
  }
  if (!Array.isArray(children)) {
    children = [children];
  }

  const c = getContext<{
    Variables: {
      accessedHandlerFiles?: Set<string>;
      accessedStyleFiles?: Set<string>;
    };
  }>();
  const { accessedHandlerFiles, accessedStyleFiles } = c.var;
  const sourceUrl = c.req.header("source-url");

  let resArray: HtmlEscapedString[] | Promise<HtmlEscapedString[]>[] = [];

  // for use() hook
  const stackNode = { [DOM_STASH]: [0, []] } as unknown as NodeObject;
  const popNodeStack = (value?: unknown) => {
    buildDataStack.pop();
    return value;
  };

  try {
    stackNode[DOM_STASH][0] = 0;
    buildDataStack.push([[], stackNode]);
    resArray = children.map(childToString) as HtmlEscapedString[];
  } catch (e) {
    if (e instanceof Promise) {
      resArray = [
        e.then(() => {
          stackNode[DOM_STASH][0] = 0;
          buildDataStack.push([[], stackNode]);
          return childrenToString(children as Child[]).then(popNodeStack);
        }),
      ] as Promise<HtmlEscapedString[]>[];
    } else {
      throw e;
    }
  } finally {
    popNodeStack();
  }

  if (resArray.some((res) => (res as unknown) instanceof Promise)) {
    const index = suspenseCounter++;
    const fallbackStr = (await fallback?.toString() ?? "") as HtmlEscapedString;
    return raw(
      `<div id="suspended-${index}" style="display:contents">${fallbackStr}</div>`,
      [
        ...((fallbackStr as HtmlEscapedString).callbacks || []),
        ({ phase, buffer, context }) => {
          if (phase === HtmlEscapedCallbackPhase.BeforeStream) {
            return;
          }
          return Promise.all(resArray).then(async (htmlArray) => {
            htmlArray = htmlArray.flat();
            const content = htmlArray.join("");
            if (buffer) {
              buffer[0] = buffer[0].replace(
                new RegExp(
                  `<div id="suspended-${index}" style="display:contents">.*?</div>`,
                ),
                content,
              );
            }

            const { fn } = await tiny.imports(headHandler);
            let html = buffer ? "" : await renderToReadableStream(
              <>
                {((accessedHandlerFiles?.size || 0) +
                      (accessedStyleFiles?.size || 0)) > 0 &&
                  (
                    <NewPartial onLoad={fn.importIntoHead}>
                      <AssetTags
                        accessedHandlerFiles={accessedHandlerFiles}
                        accessedStyleFiles={accessedStyleFiles}
                      />
                    </NewPartial>
                  )}
                <NewPartial
                  id={`suspended-${index}`}
                  onLoad={onLoad}
                >
                  {raw(content)}
                </NewPartial>
              </>,
            ).then((stream) => stream.getReader().read()).then((result) => {
              const decoder = new TextDecoder();
              const string = decoder.decode(result.value);
              // console.log("Rendered string: ", string);
              if (sourceUrl === undefined) {
                return string;
              }
              return `<update>${string}</update>`;
            });

            const callbacks = htmlArray
              .map((html) => (html as HtmlEscapedString).callbacks || [])
              .flat();
            if (!callbacks.length) {
              return html;
            }

            if (phase === HtmlEscapedCallbackPhase.Stream) {
              html = await resolveCallback(
                html,
                HtmlEscapedCallbackPhase.BeforeStream,
                true,
                context,
              );
            }

            return raw(html, callbacks);
          });
        },
      ],
    );
  } else {
    return raw(resArray.join(""));
  }
};

export const Suspense: FC<SuspenseProps> = async (props) => {
  const { fn } = await tiny.imports(partialInsertHandlers);
  return await CustomSuspense({ ...props, onLoad: fn.partialBlast }) ??
    raw("");
};

// Framework wrappers render into the caller's component scope.
transparent(CustomSuspense);
transparent(Suspense);
