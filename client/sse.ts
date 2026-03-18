/**
 * Server-Sent Events client script for @tinytools/hono-tools
 *
 * Provides SSE connection handling for real-time updates from the server.
 */

import { processIncomingData } from "./processIncomingData.ts";

const currentUrl = new URL(globalThis.location.href);
const sseIdCookie = document.cookie
  .split("; ")
  .find((cookie) => cookie.startsWith("sseId="))?.split("=")[1];
console.log("Open browser SSE ID cookie: ", sseIdCookie);

const sse = new EventSource(
  `/sse?path=${encodeURIComponent(currentUrl.pathname)}`,
  {
    withCredentials: false,
  },
) as EventSource & { wasConnected?: boolean };

sse.onopen = () => {
  console.log("Connected to server, wasConnected: ", sse.wasConnected);
  if (sse.wasConnected) {
    globalThis.location.reload();
  }
  sse.wasConnected = true;
};

sse.onerror = (err) => {
  console.log("Connection Lost:", err);
};

// SSE message stream controller - we create a synthetic Response
// that processIncomingData can consume, piping SSE messages into it
let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
let sseBuffer = "";
const encoder = new TextEncoder();

sse.onmessage = (event) => {
  console.log(
    `Received SSE at ${Temporal.Now.zonedDateTimeISO().toLocaleString()}: `,
    event.data,
  );
  const text = event.data as string;
  console.log("sse chunk length: ", text.length);

  sseBuffer += text;

  // If we don't have an active stream and we're receiving data, start one
  if (streamController === null) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    // Process this response asynchronously
    processIncomingData(
      new Response(stream, {
        headers: { "Content-Type": "text/html" },
      }),
      {
        updateCachedTemplates: true,
      },
    ).then(() => {
      console.log("SSE Response processing completed");
    }).catch((err) => {
      console.error("Error processing SSE response:", err);
    });
  }

  // Enqueue the text into the stream for processIncomingData to consume
  if (streamController) {
    streamController.enqueue(encoder.encode(text));
  }

  // Check if we've received the closing </update> tag - if so, close the stream
  if (sseBuffer.endsWith("</update>")) {
    console.log("SSE message complete, closing stream");
    if (streamController) {
      streamController.close();
      streamController = null;
    }
    sseBuffer = "";
  }
};

sse.addEventListener("connection", async (event) => {
  console.log("New SSE connection established, id:", event.data);
  console.log("Setting SSE ID cookie via cookieStore API");
  await cookieStore.set({
    name: "sseId",
    value: event.data,
    expires: Temporal.Now.instant().add({ hours: 24 }).epochMilliseconds,
    path: "/",
  });
});

globalThis.addEventListener("visibilitychange", () => {
  console.log("Changed visibility: ", globalThis.document.visibilityState);
  if (globalThis.document.visibilityState === "visible") {
    console.log("SSE ReadyState: ", sse.readyState);
  }
});
