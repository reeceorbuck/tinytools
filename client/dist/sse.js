import { processIncomingData } from "./processIncomingData.js";
const currentUrl = new URL(globalThis.location.href);
const sseIdCookie = document.cookie.split("; ").find((cookie) => cookie.startsWith("sseId="))?.split("=")[1];
console.log("Open browser SSE ID cookie: ", sseIdCookie);
const sse = new EventSource(
  `/sse?path=${encodeURIComponent(currentUrl.pathname)}`,
  {
    withCredentials: false
  }
);
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
let streamController = null;
let sseBuffer = "";
const encoder = new TextEncoder();
sse.onmessage = (event) => {
  console.log(
    `Received SSE at ${Temporal.Now.zonedDateTimeISO().toLocaleString()}: `,
    event.data
  );
  const text = event.data;
  console.log("sse chunk length: ", text.length);
  sseBuffer += text;
  if (streamController === null) {
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
      }
    });
    processIncomingData(
      new Response(stream, {
        headers: { "Content-Type": "text/html" }
      })
    ).then(() => {
      console.log("SSE Response processing completed");
    }).catch((err) => {
      console.error("Error processing SSE response:", err);
    });
  }
  if (streamController) {
    streamController.enqueue(encoder.encode(text));
  }
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
    path: "/"
  });
});
globalThis.addEventListener("visibilitychange", () => {
  console.log("Changed visibility: ", globalThis.document.visibilityState);
  if (globalThis.document.visibilityState === "visible") {
    console.log("SSE ReadyState: ", sse.readyState);
  }
});
