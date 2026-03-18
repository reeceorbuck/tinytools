import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { SSEStreamingApi } from "hono/streaming";

export interface StreamData {
  id: string;
  userName: string;
  userAgent: string;
  paths: Map<string, {
    lastUpdated: number;
  }>;
}

export const activeStreams: Map<SSEStreamingApi, StreamData> = new Map();
const streamsById: Map<string, SSEStreamingApi | string> = new Map();

class AddedStreamEvent extends Event {
  static readonly eventName = "streamAdded";

  readonly stream: SSEStreamingApi;
  readonly addedId: string;

  constructor(stream: SSEStreamingApi, addedId: string) {
    super(AddedStreamEvent.eventName, { bubbles: true, composed: true });
    this.stream = stream;
    this.addedId = addedId;
  }
}

class RemovedStreamEvent extends Event {
  static readonly eventName = "streamRemoved";

  readonly removedId: string;

  constructor(removedId: string) {
    super(RemovedStreamEvent.eventName, { bubbles: true, composed: true });
    this.removedId = removedId;
  }
}

class UpdatedStreamEvent extends Event {
  static readonly eventName = "streamUpdated";

  readonly stream: SSEStreamingApi;
  readonly updatedId: string;

  constructor(stream: SSEStreamingApi, updatedId: string) {
    super(UpdatedStreamEvent.eventName, { bubbles: true, composed: true });
    this.stream = stream;
    this.updatedId = updatedId;
  }
}

interface StreamEventMap {
  streamAdded: AddedStreamEvent;
  streamRemoved: RemovedStreamEvent;
  streamUpdated: UpdatedStreamEvent;
}

class TypedEventTarget {
  #target = new EventTarget();

  addEventListener<K extends keyof StreamEventMap>(
    type: K,
    listener: ((event: StreamEventMap[K]) => void) | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!listener) {
      this.#target.addEventListener(type, null, options);
      return;
    }

    this.#target.addEventListener(
      type,
      listener as EventListener,
      options,
    );
  }

  removeEventListener<K extends keyof StreamEventMap>(
    type: K,
    listener: ((event: StreamEventMap[K]) => void) | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!listener) {
      this.#target.removeEventListener(type, null, options);
      return;
    }

    this.#target.removeEventListener(
      type,
      listener as EventListener,
      options,
    );
  }

  dispatchEvent(event: StreamEventMap[keyof StreamEventMap]): boolean;
  dispatchEvent(event: Event): boolean {
    return this.#target.dispatchEvent(event);
  }
}

export const streamEvents = new TypedEventTarget();

export function addStream(
  { id, userName, userAgent, stream }: {
    id: string;
    userName: string;
    userAgent: string;
    stream: SSEStreamingApi;
  },
) {
  const existingEntry = streamsById.get(id);
  if (existingEntry && typeof existingEntry !== "string") {
    console.log("Stream with this ID already exists: ", id);
    return;
  } else if (existingEntry) {
    console.log("Activating existing inactive stream found for ID: ", id);
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
  console.log("New SSE stream added, active count:", activeStreams.size);
  streamEvents.dispatchEvent(new AddedStreamEvent(stream, id));
}

export function setInactiveStream(id: string, path: string) {
  streamsById.set(id, path);
  console.log("Inactive SSE stream added, active count:", activeStreams.size);
  setTimeout(() => {
    const entry = streamsById.get(id);
    if (entry && typeof entry === "string") {
      streamsById.delete(id);
      console.log("Inactive SSE stream removed:", id);
    } else {
      console.log("Inactive SSE stream not removed, active stream exists:", id);
    }
  }, 10000);
}

export function removeStream(stream: SSEStreamingApi) {
  const entry = activeStreams.get(stream);
  if (!entry) return;

  activeStreams.delete(stream);

  const currentEntry = streamsById.get(entry.id);
  if (currentEntry === stream) {
    const lastPath = [...entry.paths.keys()].pop();
    if (lastPath) {
      setInactiveStream(entry.id, lastPath);
    } else {
      streamsById.delete(entry.id);
    }
  }

  console.log("SSE stream removed, active count:", activeStreams.size);
  streamEvents.dispatchEvent(new RemovedStreamEvent(entry.id));
}

export function updateStreamPath(
  id: string,
  path: string,
  replacePath?: string,
) {
  let streamOrPath = streamsById.get(id);
  if (!streamOrPath) {
    setInactiveStream(id, path);
    streamOrPath = path;
  }

  if (typeof streamOrPath === "string") {
    streamsById.set(id, path);
    console.log(
      `Updated inactive stream path for SSE ID: ${id}, path: ${path}`,
    );
    return new Map([[path, { lastUpdated: Date.now() }]]);
  }

  const streamData = activeStreams.get(streamOrPath);
  if (!streamData) throw new Error(`No stream data found for stream id: ${id}`);

  if (replacePath) {
    console.log("replacePath: ", replacePath);
    const matchedReplacePath = streamData.paths.get(replacePath);
    console.log("matchedReplacePath: ", matchedReplacePath);
    if (matchedReplacePath) streamData.paths.delete(replacePath);
  }

  const matchedPath = streamData.paths.get(path);
  if (matchedPath) streamData.paths.delete(path);
  streamData.paths.set(path, { lastUpdated: Date.now() });

  if (streamData.paths.size > 10) {
    const firstKey = streamData.paths.keys().next().value;
    if (!firstKey) throw new Error("No first key found in stream paths");
    streamData.paths.delete(firstKey);
  }

  console.log(`Updated stream data for SSE ID: ${id}, path: ${path}`);

  streamEvents.dispatchEvent(new UpdatedStreamEvent(streamOrPath, id));
  return streamData.paths;
}

export function getStreamDataById(id: string) {
  const stream = streamsById.get(id);
  if (!stream || typeof stream === "string") return undefined;
  return { stream, streamData: activeStreams.get(stream) };
}

export const trackConnectedClients = createMiddleware(async (c, next) => {
  if (c.req.path === "/sse" || c.req.path.startsWith("/sse/")) {
    await next();
    return;
  }

  let blockPathUpdate = false;

  let path = c.req.path;
  const pathArray = path.split("/");

  if (pathArray.includes("api")) {
    const destinationHeader = c.req.header("destination-url");

    if (destinationHeader) {
      const destinationUrl = new URL(destinationHeader, c.req.url);
      path = destinationUrl.pathname;
      console.log("Updated path to destinationUrl: ", path);
    } else {
      blockPathUpdate = true;
    }
  }

  if (path.startsWith("/.")) {
    blockPathUpdate = true;
  }

  const existingSseId = getCookie(c, "sseId");
  const sseId = existingSseId || crypto.randomUUID();
  c.set("sseId", sseId);

  if (!blockPathUpdate) {
    if (!existingSseId) {
      console.log("No existing SSE ID cookie found in request");
      setCookie(c, "sseId", sseId);
      console.log("Assigned new sseId cookie: ", sseId);
    }

    const updatedPaths = updateStreamPath(sseId, path);
    console.log("Updated paths: ", updatedPaths);
    c.set("paths", updatedPaths.entries().toArray());
  } else if (existingSseId) {
    const data = getStreamDataById(existingSseId);
    c.set("paths", data?.streamData?.paths.entries().toArray());
  }

  await next();
});
