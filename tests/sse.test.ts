import { assertEquals, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import {
  activeStreams,
  addStream,
  getClientId,
  getRequesterStream,
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

const TAB_A = "a".repeat(32);
const TAB_B = "b".repeat(32);

Deno.test({
  name:
    "trackConnectedClients assigns a hardened cookie and records each tab's paths",
  // A client without an open stream keeps a short-lived path record (timer).
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const app = new Hono<{ Variables: { paths?: unknown[] } }>().use(
      trackConnectedClients,
    );
    app.get("*", (c) => c.text(String(c.get("paths")?.length ?? "none")));

    // A full page load has no tab id yet, so nothing is recorded.
    const first = await app.request("/patients");
    const cookie = first.headers.get("set-cookie") ?? "";
    assertStringIncludes(cookie, "sseId=");
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Lax");
    assertStringIncludes(cookie, "Path=/");
    assertEquals(await first.text(), "none");

    const sseId = cookie.match(/sseId=([^;]+)/)![1];
    const idA = `${sseId}:${TAB_A}`;
    const idB = `${sseId}:${TAB_B}`;
    const streamA = fakeStream();
    const streamB = fakeStream();
    const added: string[] = [];
    const listener = (event: { addedId: string }) => added.push(event.addedId);
    streamEvents.addEventListener("streamAdded", listener);
    try {
      // Each tab's stream reports the page it loaded.
      addStream({
        id: idA,
        userName: "Tester",
        userAgent: "deno",
        stream: streamA,
        path: "/patients",
      });
      addStream({
        id: idB,
        userName: "Tester",
        userAgent: "deno",
        stream: streamB,
        path: "/messages",
      });
      assertEquals(added, [idA, idB]);

      const headersA = { cookie: `sseId=${sseId}`, "tt-tab-id": TAB_A };
      await (await app.request("/patients/5", { headers: headersA })).text();
      // API requests are tracked under the page they are displayed on.
      await (await app.request("/patients/api/search", {
        headers: { ...headersA, "destination-url": "/patients/6?tab=notes" },
      })).text();
      // API requests without a destination, and dot-paths, are not pages.
      await (await app.request("/patients/api/other", { headers: headersA }))
        .text();
      await (await app.request("/.well-known/thing", { headers: headersA }))
        .text();
      // Without a tab id, or with a malformed one, nothing is tracked.
      await (await app.request("/patients/9", {
        headers: { cookie: `sseId=${sseId}` },
      })).text();
      await (await app.request("/patients/10", {
        headers: { cookie: `sseId=${sseId}`, "tt-tab-id": "not-a-tab" },
      })).text();

      const dataA = activeStreams.get(streamA)!;
      assertEquals(getTrackedStreamPaths(dataA), [
        "/patients",
        "/patients/5",
        "/patients/6",
      ]);
      // The other tab of the same browser keeps its own history.
      assertEquals(getTrackedStreamPaths(activeStreams.get(streamB)!), [
        "/messages",
      ]);
      assertEquals(streamHasExactPath(dataA, "/patients/5"), true);
      assertEquals(streamHasPathPrefix(dataA, "/patients/"), true);
      const patients = getStreamsMatchingPaths(["/patients/:id"]);
      assertEquals(patients.has(streamA), true);
      assertEquals(patients.has(streamB), false);
      assertEquals(getStreamsMatchingPaths(["/messages"]).has(streamB), true);
      assertEquals(getStreamDataById(idA)?.stream, streamA);

      // The requester's stream is the tab's, found from cookie and header.
      const requester = new Hono().get(
        "/",
        (c) => c.text(getRequesterStream(c) === streamB ? "B" : "other"),
      );
      const asB = await requester.request("/", {
        headers: { cookie: `sseId=${sseId}`, "tt-tab-id": TAB_B },
      });
      assertEquals(await asB.text(), "B");
      // Another browser can't name the tab without its cookie.
      const otherBrowser = await requester.request("/", {
        headers: { cookie: "sseId=someone-else", "tt-tab-id": TAB_B },
      });
      assertEquals(await otherBrowser.text(), "other");

      // A client-side redirect replaces the request path with the displayed one.
      const redirecting = new Hono().use(trackConnectedClients);
      redirecting.get("/x", (c) => {
        c.header("X-spa-redirect", "/y");
        return c.text("");
      });
      await (await redirecting.request("/x", { headers: headersA })).text();
      assertEquals(getTrackedStreamPaths(dataA).slice(-1), ["/y"]);
    } finally {
      streamEvents.removeEventListener("streamAdded", listener);
      removeStream(streamA);
      removeStream(streamB);
    }
    assertEquals(activeStreams.has(streamA), false);
    assertEquals(activeStreams.has(streamB), false);
  },
});

Deno.test({
  name: "getClientId needs both the browser cookie and a well-formed tab id",
  async fn() {
    const app = new Hono().get("/", (c) => c.text(getClientId(c) ?? "none"));
    const id = async (headers: Record<string, string>, query = "") =>
      (await app.request(`/${query}`, { headers })).text();
    assertEquals(
      await id({ cookie: "sseId=b1", "tt-tab-id": TAB_A }),
      `b1:${TAB_A}`,
    );
    // The stream sends its tab id as a query parameter.
    assertEquals(
      await id({ cookie: "sseId=b1" }, `?tab=${TAB_B}`),
      `b1:${TAB_B}`,
    );
    assertEquals(await id({ "tt-tab-id": TAB_A }), "none");
    assertEquals(await id({ cookie: "sseId=b1" }), "none");
    assertEquals(await id({ cookie: "sseId=b1", "tt-tab-id": "a:b" }), "none");
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
