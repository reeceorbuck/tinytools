import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import {
  activeStreams,
  addStream,
  getStreamDataById,
  getStreamsMatchingPaths,
  getTrackedStreamPaths,
  removeStream,
  streamEvents,
  streamHasExactPath,
  streamHasPathPrefix,
  trackConnectedClients,
  updateStreamPath,
} from "../sse.ts";

function fakeStream(): SSEStreamingApi {
  return { writeSSE: () => Promise.resolve() } as unknown as SSEStreamingApi;
}

Deno.test({
  name:
    "trackConnectedClients assigns a hardened cookie and records displayed paths",
  // A client without an open stream keeps a short-lived path record (timer).
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = new Hono<{ Variables: { paths?: unknown[] } }>().use(
      trackConnectedClients,
    );
    app.get("*", (c) => c.text(String(c.get("paths")?.length ?? "none")));

    const first = await app.request("/patients");
    const cookie = first.headers.get("set-cookie") ?? "";
    assertStringIncludes(cookie, "sseId=");
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Lax");
    assertStringIncludes(cookie, "Path=/");
    assertEquals(await first.text(), "1");

    const sseId = cookie.match(/sseId=([^;]+)/)![1];
    const stream = fakeStream();
    const added: string[] = [];
    const listener = (event: { addedId: string }) => added.push(event.addedId);
    streamEvents.addEventListener("streamAdded", listener);
    try {
      addStream({ id: sseId, userName: "Tester", userAgent: "deno", stream });
      assertEquals(added, [sseId]);
      // The last path from before the stream opened is carried over.
      assertEquals(getTrackedStreamPaths(activeStreams.get(stream)!), [
        "/patients",
      ]);

      const headers = { cookie: `sseId=${sseId}` };
      await (await app.request("/patients/5", { headers })).text();
      // API requests are tracked under the page they are displayed on.
      await (await app.request("/patients/api/search", {
        headers: { ...headers, "destination-url": "/patients/6?tab=notes" },
      })).text();
      // API requests without a destination, and dot-paths, are not pages.
      await (await app.request("/patients/api/other", { headers })).text();
      await (await app.request("/.well-known/thing", { headers })).text();

      const data = activeStreams.get(stream)!;
      assertEquals(getTrackedStreamPaths(data), [
        "/patients",
        "/patients/5",
        "/patients/6",
      ]);
      assertEquals(streamHasExactPath(data, "/patients/5"), true);
      assertEquals(streamHasPathPrefix(data, "/patients/"), true);
      assertEquals(
        getStreamsMatchingPaths(["/patients/:id"]).has(stream),
        true,
      );
      assertEquals(getStreamsMatchingPaths(["/messages"]).has(stream), false);
      assertEquals(getStreamDataById(sseId)?.stream, stream);

      // A client-side redirect replaces the request path with the displayed one.
      const redirecting = new Hono().use(trackConnectedClients);
      redirecting.get("/x", (c) => {
        c.header("X-spa-redirect", "/y");
        return c.text("");
      });
      await (await redirecting.request("/x", { headers })).text();
      assertEquals(getTrackedStreamPaths(data).slice(-1), ["/y"]);
    } finally {
      streamEvents.removeEventListener("streamAdded", listener);
      removeStream(stream);
    }
    assertEquals(activeStreams.has(stream), false);
  },
});

Deno.test({
  name: "updateStreamPath keeps every displayed path in recency order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const stream = fakeStream();
    addStream({ id: "cap", userName: "T", userAgent: "deno", stream });
    try {
      for (let i = 0; i < 12; i++) updateStreamPath("cap", `/page/${i}`);
      updateStreamPath("cap", "/page/5");
      const paths = getTrackedStreamPaths(activeStreams.get(stream)!);
      assertEquals(paths.length, 12);
      assertEquals(paths.at(0), "/page/0");
      assertEquals(paths.at(-1), "/page/5");
      updateStreamPath("cap", "/page/new", "/page/11");
      assertEquals(
        getTrackedStreamPaths(activeStreams.get(stream)!).includes("/page/11"),
        false,
      );
      // Adding the same id again while connected is refused.
      addStream({
        id: "cap",
        userName: "T",
        userAgent: "deno",
        stream: fakeStream(),
      });
      assertEquals(getStreamDataById("cap")?.stream, stream);
    } finally {
      removeStream(stream);
    }
  },
});
