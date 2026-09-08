/** @jsxImportSource @tinytools/hono-tools */
/** @jsxImportSourceTypes @tinytools/hono-tools */
import { Handlers, imports } from "../../clientTools.ts";
import { eventHandlerBody } from "../../eventAttributes.ts";

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

const handlers = new Handlers(import.meta.url, { recordEvent, cancel });
const { fn, events, handlers: references } = await imports(handlers);
const bindings = events({ click: "recordEvent", mouseover: "recordEvent" });
const cancelBindings = events({ click: "cancel" });
const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(eventHandlerBody),
);
const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
const script = `globalThis.handlers = {
  fn: function(event) {
    return globalThis.handlers[this.getAttribute("tt-handler-" + event.type)].call(this, event);
  },
  ${JSON.stringify(bindings["tt-handler-click"])}: ${recordEvent.toString()},
  ${JSON.stringify(cancelBindings["tt-handler-click"])}: ${cancel.toString()}
};`;

const portArgument = Deno.args.find((argument) =>
  argument.startsWith("--port=")
);
const port = Number(portArgument?.slice("--port=".length)) || 3047;

Deno.serve({ hostname: "127.0.0.1", port }, (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/handlers.js") {
    return new Response(script, {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }
  const strict = url.searchParams.has("csp");
  const policy = strict
    ? `script-src 'self'; script-src-attr 'unsafe-hashes' 'sha256-${hash}'`
    : "script-src 'self' 'unsafe-inline'";
  return new Response(
    "<!doctype html>" + String(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Event Handler Comparison</title>
          <script src="/handlers.js"></script>
        </head>
        <body>
          <h1>Event Handler Comparison</h1>
          <nav>
            <a href="/">Both handlers</a>
            {" | "}
            <a href="/?csp">Hash-only CSP</a>
          </nav>
          <h2>fn</h2>
          <button id="inline" type="button" onClick={fn.recordEvent}>
            Count: 0
          </button>
          <h2>events()</h2>
          <button id="events" type="button" {...bindings}>Count: 0</button>
          <h2>Direct handlers</h2>
          <button
            id="direct"
            type="button"
            onClick={references.recordEvent}
            onMouseOver={references.recordEvent}
          >
            Count: 0
          </button>
          <p>
            <a id="cancel" href="/unexpected" onClick={references.cancel}>
              Cancel navigation
            </a>
          </p>
        </body>
      </html>,
    ),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": policy,
      },
    },
  );
});
