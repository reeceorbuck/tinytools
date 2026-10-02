import { tiny } from "../mod.ts";
import { processIncomingDataTools } from "./processIncomingData.ts";

export const sseTools = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(processIncomingDataTools);
  return {
    activateSSE: function (
      this: HTMLElement,
      _e: Event,
    ) {
      const currentUrl = new URL(globalThis.location.href);
      const sseIdCookie = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("sseId="))?.split("=")[1];

      const sseTarget = this as HTMLElement & {
        sse: EventSource & { wasConnected?: boolean };
      };

      sseTarget.sse = new EventSource(
        `/sse?path=${encodeURIComponent(currentUrl.pathname)}`,
        {
          withCredentials: false,
        },
      ) as EventSource & { wasConnected?: boolean };

      // Warn once per outage rather than on every retry.
      let connectionLost = false;

      sseTarget.sse.onopen = () => {
        connectionLost = false;
        if (sseTarget.sse.wasConnected) {
          console.log("SSE reconnected, reloading page");
          globalThis.location.reload();
        }
        sseTarget.sse.wasConnected = true;
      };

      sseTarget.sse.onerror = () => {
        const closed = sseTarget.sse.readyState === EventSource.CLOSED;
        if (connectionLost && !closed) return;
        connectionLost = true;
        console.warn(
          closed
            ? "SSE connection closed, not retrying"
            : "SSE connection lost, retrying",
        );
      };

      // SSE message stream controller - we create a synthetic Response
      // that processIncomingData can consume, piping SSE messages into it
      let streamController: ReadableStreamDefaultController<Uint8Array> | null =
        null;
      let sseBuffer = "";
      let messageCount = 0;
      const encoder = new TextEncoder();

      sseTarget.sse.onmessage = (event) => {
        const text = event.data as string;
        messageCount++;

        sseBuffer += text;

        // If we don't have an active stream and we're receiving data, start one
        if (streamController === null) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          });

          // Process this response asynchronously
          fn.processIncomingData(
            new Response(stream, {
              headers: { "Content-Type": "text/html" },
            }),
          ).catch((err) => {
            console.error("Error processing SSE response:", err);
          });
        }

        // Enqueue the text into the stream for processIncomingData to consume
        if (streamController) {
          streamController.enqueue(encoder.encode(text));
        }

        // Check if we've received the closing </update> tag - if so, close the stream
        if (sseBuffer.endsWith("</update>")) {
          console.log(
            `SSE update received (${sseBuffer.length} chars` +
              (messageCount > 1 ? ` over ${messageCount} messages)` : ")"),
          );
          messageCount = 0;
          if (streamController) {
            streamController.close();
            streamController = null;
          }
          sseBuffer = "";
        }
      };

      sseTarget.sse.addEventListener("connection", async (event) => {
        console.log("SSE connected", {
          id: event.data,
          previousId: sseIdCookie ?? null,
          path: currentUrl.pathname,
        });
        await cookieStore.set({
          name: "sseId",
          value: event.data,
          expires: Temporal.Now.instant().add({ hours: 24 }).epochMilliseconds,
          path: "/",
        });
      });

      globalThis.addEventListener("visibilitychange", () => {
        if (
          globalThis.document.visibilityState === "visible" &&
          sseTarget.sse.readyState === EventSource.CLOSED
        ) {
          console.warn("Page visible again but SSE connection is closed");
        }
      });

      globalThis.addEventListener("beforeunload", () => {
        sseTarget.sse.close();
      });
    },
  };
});
