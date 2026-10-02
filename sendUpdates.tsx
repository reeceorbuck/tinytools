import { renderToReadableStream } from "hono/jsx/streaming";
import { AssetTags, NewPartial } from "./components/mod.ts";
import {
  createNoContextToolUsageTracker,
  withNoContextToolUsageTracker,
} from "./clientTools.ts";
import type { JSX } from "./jsx-runtime.ts";
import { headHandler, tiny } from "./honoFactory.tsx";

/** The part of Hono's SSE stream API that {@link sendUpdateStream} writes to. */
export interface UpdateStreamApi {
  writeSSE(payload: { data: string }): Promise<unknown>;
}

export interface SendUpdateOptions {
  /**
   * URLPattern pathnames the update applies to, e.g.
   * `["/patients/5", "/appointments/:date/5"]`. The client applies it to the
   * live page only when `location.pathname` matches, and to cached routes
   * whose `update-path` matches. Without paths it applies to the live page.
   */
  paths?: readonly string[];
  /** Called for each stream that could not be written to (usually closed). */
  onStreamWriteError?: (stream: UpdateStreamApi) => void;
}

/**
 * Renders `content` as a partial `<update>` document and writes it to every
 * stream. The update carries a head section importing any handler bundles and
 * stylesheets the content used, so pushed partials work like partial
 * navigation responses.
 *
 * @example
 * ```tsx
 * sendUpdateStream(
 *   <PartialReplace id="status">Updated</PartialReplace>,
 *   getStreamsMatchingPaths(["/dashboard"]),
 *   { paths: ["/dashboard"] },
 * );
 * ```
 */
export async function sendUpdateStream(
  content: JSX.Element,
  streams: Iterable<UpdateStreamApi>,
  options: SendUpdateOptions | SendUpdateOptions["onStreamWriteError"] = {},
): Promise<void> {
  const { paths, onStreamWriteError } = typeof options === "function"
    ? { paths: undefined, onStreamWriteError: options }
    : options;
  const targets = [...streams];
  if (targets.length === 0) return;

  const toolUsageTracker = createNoContextToolUsageTracker();
  const { fn } = await tiny.imports(headHandler);
  const update = (
    <update update-paths={paths?.length ? JSON.stringify(paths) : undefined}>
      <NewPartial onLoad={fn.importIntoHead}>
        <AssetTags
          accessedHandlerFiles={toolUsageTracker.accessedHandlerFiles}
          accessedStyleFiles={toolUsageTracker.accessedStyleFiles}
        />
      </NewPartial>
      {content}
    </update>
  );

  const decoder = new TextDecoder();
  await withNoContextToolUsageTracker(toolUsageTracker, async () => {
    await renderToReadableStream(update).pipeTo(
      new WritableStream({
        async write(chunk) {
          const data = decoder.decode(chunk, { stream: true });
          await Promise.all(targets.map(async (stream) => {
            try {
              await stream.writeSSE({ data });
            } catch (error) {
              onStreamWriteError?.(stream);
              console.error(
                "[tiny-tools] Failed writing an update to a stream; it may be closed.",
                error,
              );
            }
          }));
        },
      }),
    );
  });
}
