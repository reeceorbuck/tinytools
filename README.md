# @tinytools/hono-tools

A lightweight enhancement layer for [Hono](https://hono.dev/) web applications.
Provides type-safe client functions, scoped styles, and enhanced JSX event
handlers. Works with **Deno**, **Bun**, and **Node.js**.

## Features

### Core Features

- **Handlers & Styles** - Separate factories for type-safe client-side event
  handlers and scoped CSS styles
- **Enhanced JSX Types** - Better inline event types (onSubmit, onClick, etc.)
  that enforce type safety

### Optional Features

- **Suspense Component** - Streaming content with fallback support
- **Partial Component** - Declarative partial page updates
- **Client-side Navigation** - Partial navigation and page updates without full
  reloads
- **Server-Sent Events** - Real-time server-to-client updates (experimental)

## Client Route Templates

`ClientRoutes` renders local content when a navigation matches a `client-route`.
Paths use the browser's `URLPattern` syntax, including named parameters and
wildcards. Optional query rules further restrict a match:

```tsx
import { ClientRoutes } from "@tinytools/hono-tools/components";

<ClientRoutes>
  <client-route path="/patients/:id" query="tab=notes&preview=*">
    <p data-patient="$[id]">Loading notes for $[name]...</p>
  </client-route>
  <client-route path="/help/:topic" query="" data-nav-block>
    <p>Help topic: $[topic]</p>
  </client-route>
</ClientRoutes>;
```

All matching routes render in declaration order; matching containers cooperate
with core navigation. `data-nav-block` suppresses the server fetch only when
that route's path and query both match. Without it, local content can serve as a
loading state while the server response is fetched. Use your usual partial
components inside a route to replace existing content instead of appending it.

Routes default to `method="get"`; use `method="post"` for submission loading
states. Method matching uses the same resolver as the server fetch, including
the submit button's `formmethod` override. A method mismatch neither renders
content nor blocks the fetch.

| Query rule                    | Meaning                                   |
| ----------------------------- | ----------------------------------------- |
| No `query` attribute          | Accept any query string                   |
| `query=""` or `query="none"`  | Require no query parameters               |
| `key=value`                   | First value of the key equals `value`     |
| `key!=value`                  | First value differs, or the key is absent |
| `key=*`                       | Key exists, including an empty value      |
| `key=null` or `key=undefined` | Key is absent                             |
| `key=`                        | Key exists with an empty first value      |
| `a=1&b=2`                     | Both conditions match                     |
| `a=1\|b=2`                    | Either condition matches                  |

AND binds more tightly than OR: `a=1&b=2|c=3` means `(a=1 AND b=2) OR c=3`. Keys
and values use URL query decoding (`+` means a space); encode literal `&` and
`|` as `%26` and `%7C`. An encoded `%2A` matches a literal asterisk rather than
testing existence. Invalid rules disable that route with a console warning.
Routes are read on each navigation, so adding or changing a route inside an
active `ClientRoutes` template does not require reactivating the container.
Disconnected containers do not participate in navigation.

`$[name]` placeholders in text and attributes receive named path captures and
decoded query values. Query values override same-named path captures; repeated
query keys consistently use their first value. Path captures retain URLPattern's
encoded representation. Missing values become empty strings. Matching and
interpolation use the resolved fetch URL, including `data-nav-partial`
overrides.

For POST routes, submitted form values override query values and path captures.
Repeated form keys use their first value, and values are converted to strings.
For example, `$[pair-id]` and `$[send-as]` can populate a sending-state partial
from the submitted fields. Query rules still inspect the URL, not the form body.

Each match clones the authored content, including nested templates, so routes
can render repeatedly without consuming or modifying their source. Replacement
is single-pass and literal: values containing `$&` or `$[other]` are not
expanded again. Values are assigned through DOM text and attribute APIs, not
parsed as HTML. This is not a URL or script sanitizer: do not substitute
untrusted values into event handlers, scripts, styles, or unconstrained
URL-valued attributes. This component does not reactivate archived suspense
templates or the archived route cache.

Routes can declare `from-partial-id` to capture an element's child content into
their insertion template (`template[for-partial-id]`). This is built into
`ClientRoutes`: there is no callback attribute, handler lookup, or leave event.
Capture occurs when the source URL matches `from-path` (or `path` when omitted),
using the route's query rules, independently of the destination request method.
Capture moves the actual child nodes into the insertion template synchronously
in the navigation listener, leaving the target empty. Destination rendering
runs in `intercept({ handler })`, after navigation event dispatch finishes.
Routes with `from-partial-id` move their stored nodes into a cloned insertion
wrapper; ordinary authored routes clone their content. Stored nodes are not
interpolated, so user-entered `$[name]` text remains literal.
`from-path="*"` accepts every source pathname. Routes without
`from-partial-id` do not capture content.

Add `fallback` to a loading route to suppress it when any matching route has
`data-nav-block`. Other matching routes still render normally. Set
`interpolate="false"` to clone literal content without expanding `$[name]`.

### Partial Cache

Opt a replacement partial into the template-based navigation cache:

```tsx
<NewPartial id="thirdPanelContent" cache={true} onLoad={fn.partialReplace}>
  <PatientDetails />
</NewPartial>;
```

Registration reuses a sibling `ClientRoutes` container, or inserts one beside
the target if none exists. It adds an ordinary GET `client-route`, containing
the partial's insertion template and load trigger, with `data-nav-block`.
There is no separate cache lookup or restoration path in navigation or partial
replacement. Pages without cached partials receive no cache handlers or markup.

`ClientRoutes` moves the route's `from-partial-id` target's children into its
insertion template. Registered cache routes use an active-path marker inside
the target to avoid overwriting inactive caches. An active cache stays mounted
when the destination matches its path pattern or descends from a matching path.
Path ancestry uses complete segments: `/trial/a` is within `/trial`, but
`/trial-other` is not. Sibling child navigation therefore leaves parents mounted
without blocking uncached child requests. Leaving the branch captures the active
parent even when the source URL is a deeper child. Restore matching remains
unchanged and does not turn an exact parent route into a wildcard.
Returning moves those same nodes through the original insertion handler,
preserving node identity, live form values, and attached event listeners.
Only the route wrapper and load trigger are cloned. Detaching and reconnecting
nodes still triggers lifecycle callbacks; focus and running embedded content
are not guaranteed to survive. The target is empty while fetching unless an
authored route provides a loading state. Capture does not roll back if a later
listener cancels navigation or the request fails.

An exact parent path already protects its descendants. Assign parent and child
partials distinct route paths; a layout and child registered at the same path
cannot be distinguished by URL ancestry. For an explicit pattern spanning
several routes, `cache` also accepts a URLPattern:

```tsx
<NewPartial
  id="thirdPanelContent"
  cache="/trials/cache-test{/:type(a|b)}?"
  onLoad={fn.partialReplace}
>
  <CacheTrial />
</NewPartial>;
```

Navigation within that scope leaves the outer panel mounted without blocking
an uncached child request. Leaving the scope moves the outer content intact;
its child routers leave their nodes in place for that move. On restoration,
child routers reconnect and select cached content for the current URL.
There are no shared phase queues or depth sorting. Reconnect handling is
idempotent and does not add duplicate navigation listeners.

With `cache={true}`, matching uses the exact request pathname as a literal
URLPattern; a string provides the pattern explicitly. Both ignore query
strings and hashes. A restore blocks the entire GET fetch, even when only one
panel was cached; choose scopes whose cached content suffices for the route.
A parent whose stored child content cannot satisfy the destination is a cache
miss, allowing the normal server request. POST,
URL-only, and non-intercepted navigations do not restore GET cache routes. Mark
authored loading routes `fallback` if they should yield to blocking routes.

Use `partialReplace` from the `handlers` export. Eviction and SSE updates to
stored content are not implemented. This cache is separate from the archived
runtime cache.

## CSP-Friendly Event Attributes

With TinyTools configured as your JSX runtime, handler references can be used
directly on native event attributes:

```tsx
const { handlers } = await tiny.imports(buttonHandlers);

return (
  <button onClick={handlers.handleClick} onMouseOver={handlers.handleHover}>
    CSP alternative
  </button>
);
```

This preserves definition navigation and event-parameter type checking. The JSX
runtime expands each reference into the same attribute pair as `events()`.
Ordinary JSX, development JSX, and Deno's `jsx: "precompile"` are supported.
Configure `jsxImportSource` as `@tinytools/hono-tools` (or your local
`tinytools` alias), not `hono/jsx`. Components receive references unchanged and
can forward them to intrinsic elements rendered with the TinyTools runtime.

`events()` is an opt-in alternative to `fn`; existing inline handlers are
unchanged. It accepts native DOM event names (lowercase, without `on`) and
handler references or names from the tools passed to `tiny.imports()`:

```tsx
const { fn, handlers, events } = await tiny.imports(buttonHandlers);

return (
  <>
    <button onClick={fn.handleClick}>Original</button>
    <button
      {...events({
        click: handlers.handleClick,
        mouseover: handlers.handleHover,
      })}
    >
      CSP alternative
    </button>
  </>
);
```

`handlers` is a mapped collection that preserves Go to Definition navigation to
the original handler properties. References carry the literal handler name and
function signature, so same-signature handlers with unimported names are
rejected. The runtime also rejects a reference whose name resolves to a
different generated handler ID in the receiving tools. References are opaque
values, not callable server functions. Direct attributes use the imported
reference's resolved ID; `events()` additionally validates that reference
against its own imported tools. Existing `onClick={fn.handleClick}` remains
unchanged.

References and string names autocomplete from the imported tools, including
their declared dependencies. `events({ click: "handleClick" })` remains
supported and emits the same HTML. Unknown names, raw functions, `fn`
expressions, and incompatible event parameter types are rejected. For example, a
`KeyboardEvent` handler cannot be assigned to `click`. As with the existing JSX
handlers, the receiving element's `this` type is not checked by the spread
helper.

Each binding emits `tt-handler-click="handleClick_<hash>"` and `onclick` with
exactly this body, shared across all event types and handler names:

```text
handlers.fn.call(this,event)
```

Only accessed handler files are tracked for loading, just as with `fn`. The
handler receives the element as `this` and the native event as its argument. Use
`event.preventDefault()` to cancel a native default action, before awaiting in
an async handler. The current shared body does not return the dispatcher's
result, so returning `false` from the handler alone does not cancel the action.

The body is exported as `eventHandlerBody`. Derive the hash from that exact
string, not its HTML-escaped representation:

```ts
import { eventHandlerBody } from "@tinytools/hono-tools";

const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(eventHandlerBody),
);
const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
const policy =
  `script-src 'self'; script-src-attr 'unsafe-hashes' 'sha256-${hash}'`;
```

Merge these directives into your application's CSP. This does not authorize old
`fn` inline attributes or other inline scripts, nor does it configure CSP
headers for you. The standard `'unsafe-hashes'` keyword is required for hashed
event attributes. Any injected markup can reuse an authorized body, so continue
to sanitize untrusted HTML, including `tt-handler-*` attributes.

This first alternative handles native DOM events, one handler per event.
Synthetic TinyTools lifecycle hooks such as `mount` and `unmount`, and handlers
invoked by custom components instead of native event dispatch, should continue
using `fn`. This includes the custom hooks on `window-event-listener`.

For a standalone comparison, run from the package directory:

```sh
deno run -A tests/fixtures/events-csp.tsx
```

Open `http://127.0.0.1:3047/` to compare both approaches, or
`http://127.0.0.1:3047/?csp` to enable the single-hash policy. In the latter
mode, the original `fn` button is deliberately blocked. The fixture serves its
small handler registry directly; the application integration still uses normal
TinyTools asset loading.

## Installation

> **Note:** The package is published under different scope names depending on
> the registry:
>
> - **JSR** (Deno): `@tinytools/hono-tools`
> - **npm** (Node.js / Bun): `@tinyenterprise/hono-tools`

### Deno (via JSR)

```bash
deno add jsr:@tinytools/hono-tools
```

Or manually add to your `deno.json`:

```json
{
  "imports": {
    "@tinytools/hono-tools": "jsr:@tinytools/hono-tools@^0.1.0",
    "@tinytools/hono-tools/build": "jsr:@tinytools/hono-tools@^0.1.0/build",
    "@tinytools/hono-tools/components": "jsr:@tinytools/hono-tools@^0.1.0/components"
  }
}
```

Optionally, Deno supports precompiled JSX for better performance:

```json
{
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@tinytools/hono-tools"
  }
}
```

### Node.js / Bun (via npm)

```bash
# npm
npm install @tinyenterprise/hono-tools

# bun
bun add @tinyenterprise/hono-tools
```

Then import using the npm scope:

```ts
import { css, tiny } from "@tinyenterprise/hono-tools";
import { buildScriptFiles } from "@tinyenterprise/hono-tools/build";
import { Partial, Suspense } from "@tinyenterprise/hono-tools/components";
```

## Quick Start

```tsx
import { Hono } from "hono";
import { css, setCustomScope, tiny } from "@tinytools/hono-tools";
import { buildScriptFiles } from "@tinytools/hono-tools/build";

// Define client-side event handlers and styles separately
const buttonStyle = css`
  background: blue;
  color: white;
  padding: 8px 16px;
  border-radius: 4px;
  &:hover {
    background: darkblue;
  }
`;

const routeHandlers = new tiny.Handlers(import.meta.url, {
  handleClick(this: HTMLButtonElement, e: MouseEvent) {
    console.log("Clicked!", e);
    this.textContent = "Clicked!";
  },
  handleSubmit(this: HTMLFormElement, e: SubmitEvent) {
    e.preventDefault();
    console.log("Form submitted!");
  },
});

const routeStyles = new tiny.Styles(import.meta.url, {
  buttonStyle,
  cardLayout: setCustomScope.toSelectors(
    css`
      display: grid;
      gap: 12px;
    `,
    [".scopeBoundary>*"],
  ),
  articleBody: setCustomScope.toSelectors(
    css`
      font-size: 0.95rem;
    `,
    [".scope-break", "[data-scope-stop]"],
  ),
  articleInnerLayout: setCustomScope.toSelectors(
    css`
      margin-block: 8px;
    `,
    [".scope-break>*", "[data-scope-stop]>*"],
  ),
});

// Create Hono app with tools using middleware
const app = new Hono()
  .use(...tiny.middleware.all())
  .use(tiny.middleware.sharedImports(routeHandlers, routeStyles));

// Use in routes
app.get("/", (c) => {
  const { fn, styled } = c.var.tools;

  return c.render(
    <button class={styled.buttonStyle} onClick={fn.handleClick}>
      Click me
    </button>,
  );
});

// Build client files before starting server
await buildScriptFiles();

export default app;
```

> Scope helper methods are exposed under `setCustomScope` (for example
> `setCustomScope.toSelectors(..., [".scopeBoundary>*"])`). Direct named imports
> of `scopedTo*`/`unscoped` are no longer part of the top-level API.

> Use `setCustomScope.direct(cssContent)` for content that must be emitted
> directly inside `@scope` instead of inside the generated `:scope` rule. This
> supports name-defining at-rules such as `@keyframes`; those names remain
> global according to CSS scoping rules, so they should be chosen to avoid
> collisions.

> All scoped styles automatically include two additional scope limits:
> `[data-scope-boundary~="<generated-style-class>"]` and
> `[data-scope-boundary~="global"]`. The `~=` operator ensures exact token
> matching, so `global` does not match partial values like `my-global-theme`.

> **⚠️ Important:** Always declare `Handlers` and `Styles` instances at **module
> level** (outside of route handlers). This ensures handlers and styles are
> registered once at startup and included in the build. Creating them inside a
> route handler would re-register them on every request, causing performance
> issues and build inconsistencies.

## API Reference

### Core Module (`@tinytools/hono-tools`)

#### `tiny.middleware`

The `tiny` singleton provides composable middleware for opt-in feature
selection. Each feature is a separate middleware that can be applied
independently.

**`tiny.middleware.core(options?)`** - Core middleware array (context storage,
static file serving, JSX renderer, tools init). Spread into `.use()`.

**`tiny.middleware.navApiTools()`** - Enables client-side navigation (Navigation
API + event handlers).

**`tiny.middleware.sseTools()`** - Enables Server-Sent Events support and tracks
each connected client's `sseId` plus recent route paths.

**`tiny.middleware.localRoutes()`** - Enables client-side local route matching.

**`tiny.middleware.webComponents()`** - Enables lifecycle and window-event web
components.

**`tiny.middleware.layout(renderFn)`** - Adds a layout wrapper for sub-routes.
Skips the callback on partial requests with a `source-url` header.

**`tiny.middleware.partialLayout(renderFn)`** - Uses the same layout composition,
but invokes the callback for both full-page and partial requests. The callback
receives `({ children }, c)` and can inspect `c.req.header("source-url")` to decide
whether to render a wrapper or return children directly. Like `layout`, it also
performs a preliminary render with empty children to register layout tools/styles.

**`tiny.middleware.all(options?)`** - Enables all features at once.

```ts
import { Hono } from "hono";
import { tiny } from "@tinytools/hono-tools";

const handlers = new tiny.Handlers(import.meta.url, {
  handleClick() {
    console.log("clicked");
  },
});

// Opt-in: only core tools (no client scripts)
const app = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.sharedImports(handlers));

// Opt-in: core + navigation + SSE
const app2 = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.navApiTools())
  .use(tiny.middleware.sseTools())
  .use(tiny.middleware.sharedImports(handlers));

// Everything enabled
const app3 = new Hono()
  .use(...tiny.middleware.all({ generatedStyleHashLength: 4 }))
  .use(tiny.middleware.sharedImports(handlers));
```

#### `tiny.middleware.sharedImports(...tools)`

Creates middleware that extends the current tools context with additional
Handlers/Styles. Pass one or more tool groups to add route-specific or app-level
handlers and styles in a single middleware call.

```ts
import { Hono } from "hono";
import { tiny } from "@tinytools/hono-tools";

const globalHandlers = new tiny.Handlers(import.meta.url, {
  globalHandler() {
    console.log("global");
  },
});

const app = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.sharedImports(globalHandlers));

const routeTools = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.sharedImports(globalHandlers, routeStyles));
```

#### `withAncestors<T>`

Type helper for declaring ancestor tools in child routes. This provides type
safety when accessing tools from parent routes.

```ts
import { Hono } from "hono";
import { tiny, type withAncestors } from "@tinytools/hono-tools";
import type { globalTools } from "./main.tsx";
import type { parentTools } from "./parent.tsx";

const localHandlers = new tiny.Handlers(import.meta.url, {
  localHandler() {
    console.log("local");
  },
});

// Child route with ancestor type declarations
export const childRoute = new Hono<
  withAncestors<[typeof parentTools, typeof globalTools]>
>()
  .use(tiny.middleware.sharedImports(localHandlers))
  .get("/", (c) => {
    const { fn } = c.var.tools;
    // Has access to: localHandler, parentTools handlers, globalTools handlers
    return c.render(<div onClick={fn.localHandler}>Click</div>);
  });
```

#### `Handlers` & `Styles`

Separate factories for creating type-safe client-side event handlers and scoped
CSS styles.

> **⚠️ Always declare at module level** - `Handlers` and `Styles` instances must
> be created outside of route handlers so they are registered once at startup
> and included in the build process.

The first argument to `Handlers` and `Styles` is an optional `import.meta.url`.
When provided, the build step tracks which file each handler/style belongs to
and only rebuilds the files that have changed. This makes development faster
because rebuilds happen lazily — only the affected output files are regenerated
instead of everything. If omitted, all handlers and styles are rebuilt on every
change.

```ts
// With import.meta.url (recommended) — enables lazy, incremental rebuilds
const handlers = new tiny.Handlers(import.meta.url, { ... });

// Without — still works, but every change triggers a full rebuild
const handlers = new tiny.Handlers({ ... });
```

```ts
import { css, tiny } from "@tinytools/hono-tools";

const myStyle = css`
  color: blue;
  padding: 16px;
`;

// ✅ Correct: declared at module level
const handlers = new tiny.Handlers(import.meta.url, {
  handlerName(this: HTMLElement, e: Event) {
    // Handler code runs in the browser
  },
});

const styles = new tiny.Styles(import.meta.url, {
  myStyle,
});

// Import handlers from other files
const localHandlers = new tiny.Handlers(import.meta.url, {
  imports: [externalHandlers],
}, {
  localHandler() {
    // ...
  },
});
```

#### Reusing a client function inside another client function

Use `getFunctionReferences` when a client function needs to call another client
function during module-level setup.

Why this is required:

- `fn.*` is an activated request-time proxy (available in route/component
  context)
- `functions: { ... }` is declared at module load time (no request context yet)
- `getFunctionReferences` gives stable function references that can be called
  from inside other client function bodies

There are two different patterns to follow:

- **Across separate instances**: use `otherTools.getFunctionReferences`, and
  ensure the calling instance includes the referenced tools in `imports: [...]`.
- **Within the same `Handlers` instance**: if one handler calls another, declare
  the referenced function at module scope (outside the constructor) and then
  assign it into the handlers, instead of only declaring it inline.

##### Across separate instances (including different files)

```ts
import { tiny } from "@tinytools/hono-tools";

const externalHandlers = new tiny.Handlers(import.meta.url, {
  externalFunction(msg: string) {
    console.log("external", msg);
  },
});

// Module-level reference for composition inside another client function
const { externalFunction } = externalHandlers.getFunctionReferences;

export const localHandlers = new tiny.Handlers(
  import.meta.url,
  // Required when localHandlers calls functions from externalHandlers
  { imports: [externalHandlers] },
  {
    handleClick(this: HTMLElement, _e: MouseEvent) {
      externalFunction("called from handleClick");
      this.textContent = "done";
    },
  },
);
```

##### Within the same `Handlers` instance

```ts
import { tiny } from "@tinytools/hono-tools";

// Declare at module scope so other handlers can reference it safely. Must be defined in the same file.
const sharedHandler = function (this: HTMLElement, e: MouseEvent) {
  console.log("shared", this, e);
};

export const handlers = new tiny.Handlers(import.meta.url, {
  sharedHandler,
  nestedHandler: function (this: HTMLElement, e: MouseEvent) {
    sharedHandler.call(this, e);
  },
});
```

Use `fn.*` only when attaching handlers in JSX/render code:

```tsx
app.get("/", async (c) => {
  const { fn } = await c.var.tools.extendWithImports(localHandlers);
  return c.render(<button onClick={fn.handleClick}>Run</button>);
});
```

#### `await c.var.tools.extendWithImports(localTools)`

Extend tools within a route handler for single-route tools that don't need
middleware. Returns a tools object with both parent and local tools.

> **Note:** The `Handlers`/`Styles` instance must still be declared at module
> level, outside the route handler. Only the `extendWithImports()` call happens
> inside the handler.

```ts
// ✅ Declare at module level - registered once at startup
const singleRouteHandlers = new tiny.Handlers(import.meta.url, {
  specialHandler() {
    console.log("special");
  },
});

app.get("/special", async (c) => {
  // Use extendWithImports inside the handler to access the tools
  const { fn, styled } = await c.var.tools.extendWithImports(
    singleRouteHandlers,
  );

  return c.render(
    <button onClick={fn.specialHandler}>Special</button>,
  );
});
```

#### `getTools()`

Access tools from within async components (outside of route handlers). This uses
Hono's context storage to retrieve the current request's tools.

> **Note:** The `Handlers`/`Styles` instance must still be declared at module
> level. `getTools()` is for accessing tools inside components, not for
> declaring them.

```tsx
import { css, getTools, tiny } from "@tinytools/hono-tools";

const buttonStyle = css`
  background: blue;
`;

// ✅ Declare at module level
const componentHandlers = new tiny.Handlers(import.meta.url, {
  buttonClick() {
    console.log("clicked");
  },
});

const componentStyles = new tiny.Styles(import.meta.url, { buttonStyle });

// Component that uses tools
function MyButton({ label }: { label: string }) {
  // Access tools from context - works in async components
  const { fn, styled } = getTools().extendWithImports(
    componentHandlers,
    componentStyles,
  );

  return (
    <button class={styled.buttonStyle} onClick={fn.buttonClick}>
      {label}
    </button>
  );
}

// Use in a route
app.get("/", (c) => {
  return c.render(<MyButton label="Click me" />);
});
```

For full type safety with ancestor tools, pass the tool types as a generic:

```tsx
import type { globalTools } from "./main.tsx";

function MyComponent() {
  // Type-safe access to both local and ancestor tools
  const { fn } = getTools<[typeof globalTools]>().extend(
    componentHandlers,
  );

  return <div onClick={fn.globalHandler}>Uses global handler</div>;
}
```

### Build Module (`@tinytools/hono-tools/build`)

#### `buildScriptFiles(options?)`

Builds all registered client functions and scoped styles to the public
directory.

```ts
import { buildScriptFiles } from "@tinytools/hono-tools/build";

await buildScriptFiles({
  clientDir: "./client", // Source directory for client scripts
  publicDir: "./public", // Output directory
  handlerDir: "./public/handlers",
  stylesDir: "./public/styles",
});
```

### Components Module (`@tinytools/hono-tools/components`)

#### `Suspense`

Streaming content with fallback support.

```tsx
import { Suspense } from "@tinytools/hono-tools/components";

<Suspense fallback={<Loading />}>
  <AsyncContent />
</Suspense>;
```

#### `Partial`

Declarative partial page updates.

```tsx
import { Partial } from "@tinytools/hono-tools/components";
import {
  partialInsertHandlers,
} from "@tinytools/hono-tools/partial-insert-handlers";

const app = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.sharedImports(partialInsertHandlers));

app.get("/profile", (c) => {
  const { fn } = c.var.tools;
  return (
    <Partial
      id="user-profile"
      onMount={fn.partialReplace}
    >
      <UserProfile />
    </Partial>
  );
});
```

Available handlers are `partialReplace`, `partialDelete`, `partialBlast`,
`partialAttributes`, `partialMergeContent`, `partialRouteCache`, and
`partialAutofocus`. Every partial requires an `onMount` handler.

The server renders `<partial-content>`. Navigation and SSE processing only add
incoming elements to the document; the custom element invokes `onMount` from its
`connectedCallback`. Insertion handlers find the live element using the partial
content's own `id`.

Features can be composed at the application boundary. Imported handlers are
included in generated modules, so an app handler can opt into cache writes and
autofocus before choosing its insertion behavior:

```tsx
const { partialRouteCache, partialAutofocus, partialReplace } =
  partialInsertHandlers.getFunctionReferences;

const appPartials = new tiny.Handlers(
  import.meta.url,
  { imports: [partialInsertHandlers] },
  {
    replaceWithFeatures: function () {
      if (partialRouteCache.call(this) === false) return;
      partialAutofocus.call(this);
      return partialReplace.call(this);
    },
  },
);
```

Route-cache reads remain part of Navigation/local-route processing. Cache
creation, outgoing capture, stale-response storage, and cached-template updates
are performed by `partialRouteCache` only when the app includes it.

### Client Module (`@tinytools/hono-tools/client`)

Client-side scripts for partial navigation. Copy these to your public directory
or use the build module to transpile them.

Required scripts for partial navigation:

- `eventHandlers.ts` - Global handler proxy
- `navigation.ts` - Navigation API integration
- `processIncomingHtml.ts` - DOM update processing
- `processIncomingData.ts` - Response processing
- `performFetchAndUpdate.ts` - Fetch and update logic

Optional scripts:

- `sse.ts` - Server-Sent Events support
- `wc-lifecycleElement.ts` - Lifecycle web component
- `wc-windowEventlistener.ts` - Window event listener web component

## Type Safety

The package provides full TypeScript support with branded types for client
functions:

```tsx
// ✅ Works - fn from c.var.tools are activated
const { fn } = c.var.tools;
<button onClick={fn.handleClick}>Click</button>;

// ❌ Error - functions from handlers are not activated until used via middleware
const handlers = new tiny.Handlers(import.meta.url, {
  fn() {},
});
<button onClick={handlers.fn}>Click</button>; // Type error!
```

## License

MIT
