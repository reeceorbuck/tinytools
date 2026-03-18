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
import { getClientFileName } from "../client/dist/manifest.ts";

const childrenToString = async (
  children: Child[],
): Promise<HtmlEscapedString[]> => {
  try {
    return children
      .flat()
      .map((
        c,
      ) => (c == null || typeof c === "boolean"
        ? ""
        : c.toString())
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
export const Suspense: FC<
  PropsWithChildren<
    // deno-lint-ignore no-explicit-any
    { fallback: any }
  >
> = async ({
  children,
  fallback,
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
    resArray = children.map((c) =>
      c == null || typeof c === "boolean" ? "" : c.toString()
    ) as HtmlEscapedString[];
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
              console.log(
                "There is a buffer! See if we can replace content before it sends",
              );
              buffer[0] = buffer[0].replace(
                new RegExp(
                  `<div id="suspended-${index}" style="display:contents">.*?</div>`,
                ),
                content,
              );
            }

            const headUpdate = Array.from(
              accessedHandlerFiles || [],
              // deno-lint-ignore jsx-key
            ).map((file) => <script src={`/handlers/${file}`} type="module" />)
              .join("") + Array.from(
                accessedStyleFiles || [],
              ).map((file) => (
                <link rel="stylesheet" href={`/styles/${file}`} />
              ))
              .join("");

            let html = buffer
              ? ""
              : `<update id="u${index}"><template><head-update>${headUpdate}</head-update><body-update><partial id="suspended-${index}" mode="blast">${content}</partial></body-update></template></update>${
                sourceUrl === undefined
                  ? `<script type="module" id="s${index}">import{processIncomingHtml}from'/_tinytools/${
                    getClientFileName("processIncomingHtml.js")
                  }';const u=document.getElementById('u${index}'),t=u.querySelector('template').content;t.querySelector('head-update').childNodes.forEach(c=>document.head.appendChild(c.cloneNode(true)));processIncomingHtml(t.querySelector('body-update'));u.remove();document.getElementById('s${index}').remove()</script>`
                  : ""
              }`;

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
