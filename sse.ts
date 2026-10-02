/**
 * Server-sent event stream tracking for @tinytools/hono-tools.
 *
 * Applications register their own SSE endpoint and call {@link addStream} /
 * {@link removeStream} for each connection. {@link trackConnectedClients}
 * records which page paths each client has displayed, so server events can
 * be sent only to clients that are showing (or have cached) affected content.
 *
 * @module
 */

import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Context, MiddlewareHandler } from "hono";
import type { SSEStreamingApi } from "hono/streaming";

/** Name of the cookie identifying a browser's SSE connection. */
export const SSE_ID_COOKIE = "sseId";

/** How long a path record is kept for a client whose stream has closed. */
const INACTIVE_STREAM_TTL_MS = 10_000;

/** Maximum number of recently displayed paths remembered per client. */
const MAX_TRACKED_PATHS = 10;

export interface StreamData {
  id: string;
  userName: string;
  userAgent: string;
  /** Recently displayed page paths, oldest first. */
  paths: Map<string, { lastUpdated: number }>;
}

export function getTrackedStreamPaths(
  streamData: Pick<StreamData, "paths">,
): string[] {
  return [...streamData.paths.keys()];
}

export function streamHasMatchingPath(
  streamData: Pick<StreamData, "paths">,
  matcher: (path: string) => boolean,
): boolean {
  return getTrackedStreamPaths(streamData).some(matcher);
}

export function streamHasExactPath(
  streamData: Pick<StreamData, "paths">,
  path: string,
): boolean {
  return streamData.paths.has(path);
}

export function streamHasPathPrefix(
  streamData: Pick<StreamData, "paths">,
  prefix: string,
): boolean {
  return streamHasMatchingPath(
    streamData,
    (trackedPath) => trackedPath.startsWith(prefix),
  );
}

/**
 * True if any tracked path matches one of the URLPattern pathname patterns,
 * e.g. `["/patients/5", "/appointments/:date/5"]`.
 */
export function streamHasPathPattern(
  streamData: Pick<StreamData, "paths">,
  patterns: readonly string[],
): boolean {
  const compiled = patterns.map((pathname) => new URLPattern({ pathname }));
  return streamHasMatchingPath(
    streamData,
    (trackedPath) =>
      compiled.some((pattern) => pattern.test({ pathname: trackedPath })),
  );
}

/** Streams that have displayed a path matching one of the patterns. */
export function getStreamsMatchingPaths(
  patterns: readonly string[],
): Set<SSEStreamingApi> {
  const matching = new Set<SSEStreamingApi>();
  for (const [stream, streamData] of activeStreams) {
    if (streamHasPathPattern(streamData, patterns)) matching.add(stream);
  }
  return matching;
}

/**
 * The page path a request's response is displayed under: the request path,
 * or for `/api/` requests the `destination-url` pathname. Undefined when the
 * request is not displayed as a page (an API call without a destination, or
 * a dot-path asset).
 */
export function getDisplayedPath(c: Context): string | undefined {
  let path = c.req.path;
  if (path.split("/").includes("api")) {
    const destinationHeader = c.req.header("destination-url");
    if (!destinationHeader) return undefined;
    path = new URL(destinationHeader, c.req.url).pathname;
  }
  return path.startsWith("/.") ? undefined : path;
}

/** Every open stream and what its client has displayed. */
export const activeStreams: Map<SSEStreamingApi, StreamData> = new Map();

/**
 * Streams by client id. A string value is the last displayed path of a client
 * whose stream has closed, kept briefly so a reconnecting client keeps it.
 */
const streamsById: Map<string, SSEStreamingApi | string> = new Map();

export class AddedStreamEvent extends Event {
  static readonly eventName = "streamAdded";

  constructor(readonly stream: SSEStreamingApi, readonly addedId: string) {
    super(AddedStreamEvent.eventName);
  }
}

export class RemovedStreamEvent extends Event {
  static readonly eventName = "streamRemoved";

  constructor(readonly removedId: string) {
    super(RemovedStreamEvent.eventName);
  }
}

export class UpdatedStreamEvent extends Event {
  static readonly eventName = "streamUpdated";

  constructor(readonly stream: SSEStreamingApi, readonly updatedId: string) {
    super(UpdatedStreamEvent.eventName);
  }
}

export interface StreamEventMap {
  streamAdded: AddedStreamEvent;
  streamRemoved: RemovedStreamEvent;
  streamUpdated: UpdatedStreamEvent;
}

/** An `EventTarget` whose listeners are typed by {@link StreamEventMap}. */
export class StreamEventTarget {
  #target = new EventTarget();

  addEventListener<K extends keyof StreamEventMap>(
    type: K,
    listener: ((event: StreamEventMap[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#target.addEventListener(type, listener as EventListener, options);
  }

  removeEventListener<K extends keyof StreamEventMap>(
    type: K,
    listener: ((event: StreamEventMap[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#target.removeEventListener(type, listener as EventListener, options);
  }

  dispatchEvent(event: StreamEventMap[keyof StreamEventMap]): boolean {
    return this.#target.dispatchEvent(event);
  }
}

/** Emits `streamAdded`, `streamRemoved` and `streamUpdated` events. */
export const streamEvents: StreamEventTarget = new StreamEventTarget();

/** Registers a newly connected stream under the client's id. */
export function addStream(
  { id, userName, userAgent, stream }: {
    id: string;
    userName: string;
    userAgent: string;
    stream: SSEStreamingApi;
  },
): void {
  const existingEntry = streamsById.get(id);
  if (existingEntry && typeof existingEntry !== "string") {
    console.warn(`[tiny-tools] SSE stream ${id} is already connected.`);
    return;
  }

  activeStreams.set(stream, {
    id,
    paths: existingEntry
      ? new Map([[existingEntry, { lastUpdated: Date.now() }]])
      : new Map(),
    userName,
    userAgent,
  });
  streamsById.set(id, stream);
  console.log(`[tiny-tools] SSE stream added (${activeStreams.size} active).`);
  streamEvents.dispatchEvent(new AddedStreamEvent(stream, id));
}

/**
 * Remembers `path` for a client without an open stream, so a reconnection
 * within the inactive TTL keeps receiving updates for it.
 */
export function setInactiveStream(id: string, path: string): void {
  streamsById.set(id, path);
  setTimeout(() => {
    if (typeof streamsById.get(id) === "string") streamsById.delete(id);
  }, INACTIVE_STREAM_TTL_MS);
}

/** Removes a closed stream, keeping its last path briefly for reconnection. */
export function removeStream(stream: SSEStreamingApi): void {
  const entry = activeStreams.get(stream);
  if (!entry) return;

  activeStreams.delete(stream);

  if (streamsById.get(entry.id) === stream) {
    const lastPath = getTrackedStreamPaths(entry).at(-1);
    if (lastPath) setInactiveStream(entry.id, lastPath);
    else streamsById.delete(entry.id);
  }

  console.log(
    `[tiny-tools] SSE stream removed (${activeStreams.size} active).`,
  );
  streamEvents.dispatchEvent(new RemovedStreamEvent(entry.id));
}

/**
 * Records that client `id` is now displaying `path`, optionally replacing a
 * previously recorded path (for example after a client-side redirect).
 * Returns the client's tracked paths.
 */
export function updateStreamPath(
  id: string,
  path: string,
  replacePath?: string,
): Map<string, { lastUpdated: number }> {
  let streamOrPath = streamsById.get(id);
  if (!streamOrPath) {
    setInactiveStream(id, path);
    streamOrPath = path;
  }

  if (typeof streamOrPath === "string") {
    streamsById.set(id, path);
    return new Map([[path, { lastUpdated: Date.now() }]]);
  }

  const streamData = activeStreams.get(streamOrPath);
  if (!streamData) throw new Error(`No stream data found for stream id ${id}`);

  if (replacePath) streamData.paths.delete(replacePath);
  // Re-inserting moves the path to the end, keeping the map ordered by recency.
  streamData.paths.delete(path);
  streamData.paths.set(path, { lastUpdated: Date.now() });

  while (streamData.paths.size > MAX_TRACKED_PATHS) {
    const oldest = streamData.paths.keys().next().value!;
    streamData.paths.delete(oldest);
  }

  streamEvents.dispatchEvent(new UpdatedStreamEvent(streamOrPath, id));
  return streamData.paths;
}

/** The open stream and tracked data for a client id, if connected. */
export function getStreamDataById(
  id: string,
): { stream: SSEStreamingApi; streamData: StreamData | undefined } | undefined {
  const stream = streamsById.get(id);
  if (!stream || typeof stream === "string") return undefined;
  return { stream, streamData: activeStreams.get(stream) };
}

/**
 * Assigns each browser an `sseId` cookie and records the page path every
 * response is displayed under. Sets `sseId` and `paths` on the context.
 * Requests under `/sse` are left alone.
 */
export const trackConnectedClients: MiddlewareHandler = createMiddleware(
  async (c, next) => {
    if (c.req.path === "/sse" || c.req.path.startsWith("/sse/")) {
      await next();
      return;
    }

    const displayedPath = getDisplayedPath(c);
    const existingSseId = getCookie(c, SSE_ID_COOKIE);
    const sseId = existingSseId || crypto.randomUUID();
    c.set("sseId", sseId);

    if (displayedPath !== undefined) {
      if (!existingSseId) {
        setCookie(c, SSE_ID_COOKIE, sseId, {
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        });
      }
      c.set("paths", [...updateStreamPath(sseId, displayedPath)]);
    } else if (existingSseId) {
      const data = getStreamDataById(existingSseId);
      c.set("paths", data?.streamData ? [...data.streamData.paths] : undefined);
    }

    await next();

    const redirectedPath = c.res.headers.get("X-spa-redirect");
    if (redirectedPath) updateStreamPath(sseId, redirectedPath, c.req.path);
  },
);
