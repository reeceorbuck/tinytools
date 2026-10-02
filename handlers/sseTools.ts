import { tiny } from "../mod.ts";
import { processIncomingDataTools } from "./processIncomingData.ts";

/**
 * Opens the application's `/sse` event stream and feeds its `<update>`
 * messages through `processIncomingData`, so pushed partials are applied
 * exactly like partial navigation responses.
 */
export const sseTools = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(processIncomingDataTools);
  return {
    /** Bind to `onLoad` of the element that owns the connection, typically `<body>`. */
    activateSSE: function (this: HTMLElement, _e: Event): void {
      const owner = this as HTMLElement & {
        sse?: EventSource & { wasConnected?: boolean };
      };
      const path = encodeURIComponent(globalThis.location.pathname);
      const source = new EventSource(`/sse?path=${path}`) as EventSource & {
        wasConnected?: boolean;
      };
      owner.sse = source;

      // Warn once per outage rather than on every retry.
      let connectionLost = false;

      source.onopen = () => {
        connectionLost = false;
        if (source.wasConnected) {
          // The server forgets a client's state when its stream closes, so a
          // reconnecting page may have missed updates: reload to resync.
          console.log("SSE reconnected, reloading page");
          globalThis.location.reload();
        }
        source.wasConnected = true;
      };

      source.onerror = () => {
        const closed = source.readyState === EventSource.CLOSED;
        if (connectionLost && !closed) return;
        connectionLost = true;
        console.warn(
          closed
            ? "SSE connection closed, not retrying"
            : "SSE connection lost, retrying",
        );
      };

      // Each `<update>` document may arrive over several SSE messages. They
      // are piped into a synthetic Response so processIncomingData can parse
      // them as a stream, which closes once the document is complete.
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let pending = "";
      const encoder = new TextEncoder();

      source.onmessage = (event) => {
        const text = event.data as string;
        pending += text;

        if (controller === null) {
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
            },
          });
          fn.processIncomingData(
            new Response(stream, { headers: { "Content-Type": "text/html" } }),
          ).catch((error) => {
            console.error("Error processing SSE update:", error);
          });
        }
        controller!.enqueue(encoder.encode(text));

        if (pending.endsWith("</update>")) {
          controller!.close();
          controller = null;
          pending = "";
        }
      };

      globalThis.addEventListener("beforeunload", () => source.close());
    },
  };
});
