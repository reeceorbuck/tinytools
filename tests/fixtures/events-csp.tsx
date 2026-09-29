/** @jsxImportSource @tinytools/hono-tools */
/** @jsxImportSourceTypes @tinytools/hono-tools */
import { Handlers, imports } from "../../clientTools.ts";
import { tiny } from "../../honoFactory.tsx";

function recordEvent(this: HTMLElement, event: MouseEvent) {
  this.dataset.lastEvent = event.type;
  if (event.type === "click") {
    this.dataset.count = String(Number(this.dataset.count || "0") + 1);
    this.textContent = `Count: ${this.dataset.count}`;
  }
}

function cancel(this: HTMLAnchorElement, event: MouseEvent) {
  event.preventDefault();
  this.dataset.cancelled = "true";
  return false;
}

async function recordPending(this: HTMLElement, event: MouseEvent) {
  this.dataset.pendingEvent = event.type;
  this.dataset.pending = "started";
  await new Promise((resolve) => {
    this.addEventListener("release", resolve, { once: true });
  });
  this.dataset.pending = "completed";
}

function recordLoad(this: Window, event: Event) {
  document.body.dataset.loadReceiver =
    this === (globalThis as unknown as Window) ? "window" : "unexpected";
  document.body.dataset.loadEvent = event.type;
  document.body.dataset.loadCount = String(
    Number(document.body.dataset.loadCount || "0") + 1,
  );
}

const handlers = new Handlers(import.meta.url, {
  recordEvent,
  cancel,
  recordLoad,
  recordPending,
});
const { fn, events, handlers: legacy } = await imports(handlers);
const bindings = events({ click: "recordEvent", mouseover: "recordEvent" });
const cancelBindings = events({ click: "cancel" });
const loadBindings = events({ load: "recordLoad" });
const pendingBindings = events({ click: "recordPending" });
const clientScript =
  `${tiny.runHandler.toString()}; const tiny = {runHandler};`;
const handlerScripts = new Map([
  [bindings["tt-handler-click"], recordEvent],
  [cancelBindings["tt-handler-click"], cancel],
  [loadBindings["tt-handler-load"], recordLoad],
  [pendingBindings["tt-handler-click"], recordPending],
].map(([name, handler]) => [
  `/handlers/${name}.js`,
  `export default ${handler.toString()}`,
]));
const script = `globalThis.handlers = {
  ${JSON.stringify(bindings["tt-handler-click"])}: ${recordEvent.toString()},
  ${JSON.stringify(cancelBindings["tt-handler-click"])}: ${cancel.toString()},
  ${JSON.stringify(loadBindings["tt-handler-load"])}: ${recordLoad.toString()},
  ${
  JSON.stringify(pendingBindings["tt-handler-click"])
}: ${recordPending.toString()}
};`;

const portArgument = Deno.args.find((argument) =>
  argument.startsWith("--port=")
);
const port = Number(portArgument?.slice("--port=".length)) || 3047;

const csp = tiny.middleware.csp();
const app = new tiny.Hono().use(async (context, next) => {
  if (new URL(context.req.url).searchParams.has("csp")) {
    return csp(context, next);
  }
  await next();
  context.header(
    "Content-Security-Policy",
    "script-src 'self' 'unsafe-inline'",
  );
});

app.get("*", (context) => {
  const request = context.req.raw;
  const url = new URL(request.url);
  const handlerScript = handlerScripts.get(url.pathname);
  if (handlerScript) {
    return new Response(handlerScript, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/event-handlers.js") {
    return new Response(clientScript, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/handlers.js") {
    return new Response(script, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }
  return new Response(
    "<!doctype html>" + String(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Event Handler Comparison</title>
          <script src="/event-handlers.js"></script>
          <script src="/handlers.js"></script>
        </head>
        <body onLoad={[fn.recordLoad, fn.recordLoad]}>
          <h1>Event Handler Comparison</h1>
          <nav>
            <a href="/">Both handlers</a>
            {" | "}
            <a href="/?csp">Hash-only CSP</a>
          </nav>
          <h2>handlers (legacy)</h2>
          <button id="inline" type="button" onClick={legacy.recordEvent}>
            Count: 0
          </button>
          <h2>events()</h2>
          <button id="events" type="button" {...bindings}>Count: 0</button>
          <h2>fn</h2>
          <button
            id="direct"
            type="button"
            onClick={fn.recordEvent}
            onMouseOver={fn.recordEvent}
          >
            Count: 0
          </button>
          <p>
            <a id="cancel" href="/unexpected" onClick={fn.cancel}>
              Cancel navigation
            </a>
          </p>
          <h2>Multiple handlers</h2>
          <button
            id="multiple"
            type="button"
            onClick={[fn.recordPending, fn.recordEvent]}
          >
            Count: 0
          </button>
        </body>
      </html>,
    ),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
});

Deno.serve({ hostname: "127.0.0.1", port }, app.fetch);
