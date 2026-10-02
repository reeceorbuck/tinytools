import { renderToReadableStream } from "hono/jsx/streaming";
import { AssetTags, NewPartial } from "./components/mod.ts";
import {
  createNoContextToolUsageTracker,
  withNoContextToolUsageTracker,
} from "./clientTools.ts";
import type { JSX } from "./jsx-runtime.ts";
import { headHandler, tiny } from "./honoFactory.tsx";

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
  onStreamWriteError?: (stream: UpdateStreamApi) => void;
}

export let lastUpdated = Date.now();

export async function sendUpdateStream(
  jsxContent: JSX.Element,
  watchingStreams: Set<UpdateStreamApi>,
  options:
    | SendUpdateOptions
    | SendUpdateOptions["onStreamWriteError"] = {},
) {
  const { paths, onStreamWriteError } = typeof options === "function"
    ? { paths: undefined, onStreamWriteError: options }
    : options;
  console.log(
    `Sending out stream notifications to ${watchingStreams.size} clients`,
  );
  lastUpdated = Date.now();

  const toolUsageTracker = createNoContextToolUsageTracker();

  // const wrappedContent = (
  //   <update>
  //     <template>
  //       <head-update>
  //         <AssetTags
  //           accessedHandlerFiles={toolUsageTracker.accessedHandlerFiles}
  //           accessedStyleFiles={toolUsageTracker.accessedStyleFiles}
  //         />
  //       </head-update>
  //       <body-update>
  //         {jsxContent}
  //       </body-update>
  //     </template>
  //   </update>
  // );

  const { fn } = await tiny.imports(headHandler);

  const wrappedContent = (
    <update update-paths={paths?.length ? JSON.stringify(paths) : undefined}>
      <NewPartial onLoad={fn.importIntoHead}>
        <AssetTags
          accessedHandlerFiles={toolUsageTracker.accessedHandlerFiles}
          accessedStyleFiles={toolUsageTracker.accessedStyleFiles}
        />
      </NewPartial>
      {jsxContent}
    </update>
  );

  await withNoContextToolUsageTracker(toolUsageTracker, async () => {
    await renderToReadableStream(wrappedContent).pipeTo(
      new WritableStream({
        async write(chunk) {
          const chunkString = new TextDecoder().decode(chunk);
          await Promise.all([...watchingStreams].map(async (stream) => {
            // console.log(
            //   `Writing update to stream, chunk: ${chunkString}`,
            // );
            try {
              await stream.writeSSE({ data: chunkString });
            } catch (_error) {
              onStreamWriteError?.(stream);
              console.error(
                `Failed writing to stream ${stream}. It may be closed.`,
              );
            }
          }));
        },
      }),
    );
  });
}
