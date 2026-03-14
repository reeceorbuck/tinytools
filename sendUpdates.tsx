import { renderToReadableStream } from "hono/jsx/streaming";
import { AssetTags } from "./components/mod.ts";
import {
  createNoContextToolUsageTracker,
  withNoContextToolUsageTracker,
} from "./clientTools.ts";
import type { JSX } from "./jsx-runtime.ts";

export interface UpdateStreamApi {
  writeSSE(payload: { data: string }): Promise<unknown>;
}

export let lastUpdated = Date.now();

export function sendUpdateStream(
  jsxContent: JSX.Element,
  watchingStreams: Set<UpdateStreamApi>,
  onStreamWriteError?: (stream: UpdateStreamApi) => void,
) {
  console.log(
    `Sending out stream notifications to ${watchingStreams.size} clients`,
  );
  lastUpdated = Date.now();

  const toolUsageTracker = createNoContextToolUsageTracker();

  const wrappedContent = (
    <update>
      <template>
        <head-update>
          <AssetTags
            fullPageLoad={false}
            accessedHandlerFiles={toolUsageTracker.accessedHandlerFiles}
            accessedStyleFiles={toolUsageTracker.accessedStyleFiles}
          />
        </head-update>
        <body-update>
          {jsxContent}
        </body-update>
      </template>
    </update>
  );

  void withNoContextToolUsageTracker(toolUsageTracker, async () => {
    await renderToReadableStream(wrappedContent).pipeTo(
      new WritableStream({
        write(chunk) {
          const chunkString = new TextDecoder().decode(chunk);
          watchingStreams.forEach((stream) => {
            console.log(
              `Writing update to stream, chunk: ${chunkString}`,
            );
            stream.writeSSE({
              data: chunkString,
            }).catch((_error) => {
              onStreamWriteError?.(stream);
              console.error(
                `Failed writing to stream ${stream}. It may be closed.`,
              );
            });
          });
        },
      }),
    );
  });
}
