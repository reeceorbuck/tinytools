# @tinytools/hono-tools

A lightweight enhancement layer for [Hono](https://hono.dev/) web applications.
Provides type-safe client functions, scoped styles, and enhanced JSX event
handlers. Works with **Deno**, **Bun**, and **Node.js**.

## Features

### Core Features

- **Handlers & Styles** - Separate factories for type-safe client-side event
  handlers and scoped CSS styles
- **One module per collection** - Each `tiny.Handlers`, `tiny.Store` and
  `tiny.Signals` instance is served as one browser module exporting its handlers
  by name. To split handlers into separately loaded files, create several
  instances (they can share a source file).

## Handler Bundles

Every tools instance compiles to `/handlers/<source>_<hash>.js`, named after its
source file, with one named export per handler. Elements reference a handler as
`<bundle>.<name>`, for example `tt-handler-click="routes_3fa1c.save"`, and
`tiny.runHandler` imports the bundle and calls that export. Handlers that import
other collections (through `tiny.imports()` in a factory, or `imports: [...]` in
object form) get ordinary ES imports of those bundles.

The hash covers the bundle's own code and every bundle it imports, directly or
indirectly. Editing any handler therefore gives its bundle, and every bundle
that depends on it, a new URL, while unrelated bundles keep theirs and stay
cached. Handlers within one bundle can call each other by name.

- **Enhanced JSX Types** - Better inline event types (onSubmit, onClick, etc.)
  that enforce type safety

### Optional Features

- **Suspense Component** - Streaming content with fallback support
- **Partial Component** - Declarative partial page updates
- **Client-side Navigation** - Partial navigation and page updates without full
  reloads
- **Server-Sent Events** - Real-time server-to-client updates (experimental)

## Stateful Handlers

`tiny.Store` supports the same construction and `fn.*` import syntax as
`tiny.Handlers`, but its bundle owns a private
`const stored = Object.create(null)` shared by all of its handlers. Use a
factory parameter named **`stored`** with an explicit state type:

```ts
const counters = new tiny.Store(
  import.meta.url,
  (stored: { count?: number }) => ({
    nextCount: function () {
      stored.count ??= 0;
      return ++stored.count;
    },
  }),
);

const buttons = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(counters);
  return {
    countClick: function (this: HTMLButtonElement) {
      this.textContent = String(fn.nextCount());
    },
  };
});
```

State is shared by every handler in the Store and by all callers of them,
including separate handler collections and partial navigations. Separate Store
instances are isolated, even when their code is identical. Nothing is serialized
into HTML or added to `globalThis` for state storage; the usual handler registry
is unchanged. State lasts until a full reload (or a changed module URL), not
across browser tabs. It is page-scoped, not per rendered component instance, and
is not server state.

Initialize values inside the returned functions. Factories still run on the
server; their outer closures and initial state are not serialized. The `stored`
factory parameter supplies types, not browser initialization, and must be a
single identifier (no destructuring or default value). A different parameter
name is also supported. Object-form Stores can instead use a type-only
`declare const stored: { count?: number }` in their source file.

For named signals or other shared objects, define a handler such as
`testSignal: function () { return fn.signalStore("test-signal", ""); }` and
import it into consumers. Each consumer can use `fn.testSignal()` without
repeating the name; the store accessor must return the existing object after the
first call. Creating the reference in a server-side factory will not capture it
in the emitted handlers.

## Signals

`tiny.Signals` is additive: `tiny.Store` and its `fn.*` API are unchanged.
Return signal instances from a self-contained, synchronous factory:

```ts
const trialSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed }) => {
    const anonOne = new Signal();
    const anonTwo = new Signal("initial value");
    const computedOne = new Computed(() => `${anonOne.value} with computed`, [
      anonOne,
    ]);
    return { anonOne, anonTwo, computedOne };
  },
);

const consumers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(trialSignals);
  return {
    update: function () {
      signal.anonOne.value = "updated";
      console.log(signal.computedOne.value);
    },
  };
});
```

The callback's tools and output types are inferred; `SignalTools` is also
exported for explicit annotations. Initial writable values are string, number,
boolean, or null (the default). Computed values are read-only and update
synchronously when declared dependencies change. Equal values do not notify.

Handlers import signals under `signal.*`, not `fn.*`, and use them directly
(`signal.anonOne.value`). Each collection is one bundle: the factory runs once
when the bundle loads and each signal is exported as an accessor, which the
handler's `signal.*` namespace resolves lazily, so computed closures use exactly
the same signal instances as consumers. All collections share one signal runtime module.
Collections are isolated; all consumers of one collection share page-scoped
state.

Factories run on the server to validate definitions and again in the browser to
initialize the graph. Keep them pure: no outer captures, imported helpers, async
work, or `tiny.imports()` inside them. Read and write `.value` only inside
computed callbacks or client handlers, not while defining the factory. Computed
dependencies must be constructed before their dependents. The whole collection
initializes together; this API does not promise per-signal graph pruning.

In JSX, `signal.*` uses the same CSP-aware event references as `fn.*`:

```tsx
const { signal } = await tiny.imports(trialSignals);
return <input type="text" onInput={signal.anonOne} />;
```

While rendering, `signal.*` is only an event reference: reading `.value` or
`.subscribe` from it throws. A signal handler receiving an input/change event assigns the target's string value. A
load event subscribes its receiver; alternatively call
`signal.anonOne.subscribe(this)` in a client load handler. Signal events carry
the `signal` (read `event.signal.value`); HTMLElement subscribers run their
TinyTools signal handler. Subscriptions deduplicate per target and use the
element's `abortController` when present. Computed accessors reject input/change
writes. References are not initial values: `value={signal.anonOne}` is
unsupported, and automatic DOM value binding is not included. Supply a literal
initial input value where needed.

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
URL-valued attributes.

Add `once` to a route to move its actual child nodes into the document body and
remove that route after rendering, rather than cloning its content. This works
for authored routes too, including insertion templates and their load triggers.
Rendering runs in `intercept({ handler })`, after navigation event dispatch.
`ClientRoutes` does not capture outgoing content or inspect mounted panels.

Add `fallback` to a loading route to suppress it when any matching route has
`data-nav-block`. Other matching routes still render normally. Set
`interpolate="false"` to render literal content without expanding `$[name]`.

### Partial Cache

Opt a replacement partial into the template-based navigation cache:

```tsx
<NewPartial id="thirdPanelContent" cache={true} onLoad={fn.partialReplace}>
  <PatientDetails />
</NewPartial>;
```

Both `NewPartial` and `PartialReplaceWithCache` accept `fullPageLoad` (default
`false`). Set it when the layout already renders the partial directly inside its
target element:

```tsx
const sourceUrl = c.req.header("source-url");

<PartialReplaceWithCache id="thirdPanelContent" fullPageLoad={!sourceUrl}>
  <PatientDetails />
</PartialReplaceWithCache>;
```

With `fullPageLoad`, children render in place without the initial insertion
template or its load trigger. The component does not create or find the target
element, and does not run `onLoad` on initial rendering. Keep the component a
direct child of the element identified by `id` for caching. Cache lifecycle
markup remains active, and cached restoration still uses the original insertion
handler, group name, and attributes. Partial navigation retains the usual
template insertion behavior when `fullPageLoad` is omitted or `false`.

The partial includes a lifecycle element whose load handler starts a
`MutationObserver` on the target's direct children. Its suspend handler drains
pending records and disconnects the observer. A sibling cache route container
stores the captured routes; no route is published while its content is mounted.
Pages without cached partials receive no cache handlers or markup.

When another partial replaces the target's children, the observer moves the
outgoing nodes into an insertion template and publishes an ordinary GET
`client-route` with `once`, `data-nav-block`, and `interpolate="false"`. Its
output is the insertion template followed by the modulepreload link that proxies
its load event. Restoration uses normal client-route rendering and the original
insertion handler. There is no cache lookup or capture logic in navigation or
partial replacement, no active-path markers, and no ancestry checks.

Capture depends on DOM replacement, not the URL or navigation event. A failed or
cancelled navigation that does not replace content leaves it mounted. An
authored loading partial that replaces content does cause capture. Updating a
nested panel does not capture its parent. Removing a whole parent subtree leaves
its nested content intact; nested observers suspend and resume on reconnection.
Restoration preserves node identity, live form values, and attached listeners.
Detachment still triggers lifecycle callbacks, and focus or running embedded
content is not guaranteed to survive.

For an explicit restore pattern spanning several routes, `cache` also accepts a
URLPattern:

```tsx
<NewPartial
  id="thirdPanelContent"
  cache="/trials/cache-test{/:type(a|b)}?"
  onLoad={fn.partialReplace}
>
  <CacheTrial />
</NewPartial>;
```

With `cache={true}`, matching uses the exact request pathname as a literal
URLPattern; a string provides the pattern explicitly. Both ignore query strings
and hashes. A restore blocks the entire GET fetch, even when only one panel was
cached; choose patterns whose stored content suffices for the destination. A
parent restores its captured subtree as-is, including whichever child was
mounted at replacement time. Reconnecting a child router only resumes listening
for future navigation; it does not switch child content automatically. POST,
URL-only, and non-intercepted navigations do not restore GET cache routes. Mark
authored loading routes `fallback` if they should yield to blocking routes.

Use `partialReplace` from the `handlers` export. Eviction and SSE updates to
stored content are not implemented.

## CSP-Friendly Event Attributes

TinyTools enables a script Content Security Policy by default in
`tiny.middleware.core()` and `new tiny.Hono({ tools: "core" })`. It allows
same-origin scripts and the shared hashed native event dispatcher. Legacy native
`onClick={handlers.handleClick}` attributes, arbitrary inline scripts,
cross-origin scripts, and string evaluation are blocked by this policy.

To retain the previous behavior while migrating, disable the middleware:

```ts
new Hono().use(...tiny.middleware.core({ csp: false }));
new tiny.Hono({ tools: "core", csp: false });
```

`csp: false` adds no CSP header and leaves application-provided policies alone.
It also bypasses the JSX reference transform: `fn.*` renders as a legacy inline
expression without `tt-handler-*`. This setting is request-scoped. Explicit
`events()` bindings still emit their attribute pairs. A plain `new tiny.Hono()`
still installs no middleware. For standalone use, register
`tiny.middleware.csp()` before your routes. To manage your own policy, disable
the default and include the dispatcher hash in your application policy. This
policy restricts scripts only; it does not restrict styles, images, or
connections.

With TinyTools configured as your JSX runtime, handler references can be used
directly on native event attributes:

```tsx
const { fn } = await tiny.imports(buttonHandlers);

return (
  <button onClick={fn.handleClick} onMouseOver={fn.handleHover}>
    Click
  </button>
);
```

This preserves definition navigation and event-parameter type checking. The JSX
runtime expands each reference into the same attribute pair as `events()`.
Ordinary JSX, development JSX, and Deno's `jsx: "precompile"` are supported.
Configure `jsxImportSource` as `@tinytools/hono-tools` (or your local
`tinytools` alias), not `hono/jsx`. Components receive references unchanged and
can forward them to intrinsic elements rendered with the TinyTools runtime.

`fn.*` exposes CSP-friendly references; `handlers.*` exposes the previous inline
expressions for legacy testing. `events()` is an explicit attribute-spread
alternative to direct `fn.*` bindings. It accepts native DOM event names
(lowercase, without `on`) and handler references or names from the tools passed
to `tiny.imports()`:

```tsx
const { fn, handlers, events } = await tiny.imports(buttonHandlers);

return (
  <>
    <button onClick={handlers.handleClick}>Legacy</button>
    <button
      {...events({
        click: fn.handleClick,
        mouseover: fn.handleHover,
      })}
    >
      CSP alternative
    </button>
  </>
);
```

`fn` is a mapped collection that preserves Go to Definition navigation to the
original handler properties. References carry the literal handler name and
function signature, so same-signature handlers with unimported names are
rejected. The runtime also rejects a reference whose name resolves to a
different generated handler ID in the receiving tools. References are opaque
values, not callable server functions. Direct attributes use the imported
reference's resolved ID; `events()` additionally validates that reference
against its own imported tools. `onClick={handlers.handleClick}` emits the
legacy inline expression in either mode and is blocked by the default CSP.

Inside `Handlers` factory definitions, `tiny.imports(...).fn` continues to
expose callable client dependencies for generated modules. Outside those
definitions, `fn` references are render-only objects and must not be called on
the server.

References and string names autocomplete from the imported tools, including
their declared dependencies. `events({ click: "handleClick" })` remains
supported and emits the same HTML. Unknown names, raw functions, legacy
`handlers` expressions, and incompatible event parameter types are rejected. For
example, a `KeyboardEvent` handler cannot be assigned to `click`. As with the
existing JSX handlers, the receiving element's `this` type is not checked by the
spread helper.

Each binding emits `tt-handler-click="<bundle>_<hash>.handleClick"` and
`onclick` with exactly this body, shared across all event types and handler
names:

```text
tiny.runHandler(this,event)
```

Pass an array of `fn` references to run multiple handlers for one event:

```tsx
<signal-output
  onLoad={[fn.anonymousSignalTest, fn.otherAnonymousSignalTest]}
/>;
```

The generated `tt-handler-load` attribute contains the handler references
separated by a single space. Handlers are invoked in array order without
awaiting their results, with the same `this` and event. Returning `false` does
not skip later handlers. Empty arrays emit no event binding. Arrays support `fn`
references, not legacy inline `handlers` expressions.

Only the bundles of accessed handlers are tracked for loading, just as with
`fn`. The handler receives the element as `this` and the native event as its
argument. Use `event.preventDefault()` to cancel a native default action, before
awaiting in an async handler. The current shared body does not return the
dispatcher's result, so returning `false` from the handler alone does not cancel
the action.

The middleware derives its hash from the exported `eventHandlerBody`. For a
custom policy, hash that exact string, not its HTML-escaped representation:

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

When managing your own CSP, merge these directives into your application's
policy. This does not authorize legacy `handlers` inline attributes or other
inline scripts. The standard `'unsafe-hashes'` keyword is required for hashed
event attributes. Any injected markup can reuse an authorized body, so continue
to sanitize untrusted HTML, including `tt-handler-*` attributes.

This first alternative handles native DOM events, one handler per event.
Handlers invoked directly by custom components instead of native event dispatch
should use `handlers` when they require serialized inline expressions.

For a standalone comparison, run from the package directory:

```sh
deno run -A tests/fixtures/events-csp.tsx
```

Open `http://127.0.0.1:3047/` to compare both approaches, or
`http://127.0.0.1:3047/?csp` to enable the single-hash policy. In the latter
mode, the legacy `handlers` button is deliberately blocked and `fn` works. The
fixture serves its small handler registry directly; the application integration
still uses normal TinyTools asset loading.

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
import { NewPartial, Suspense } from "@tinyenterprise/hono-tools/components";
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
  .use(...tiny.middleware.core());

// Use in routes
app.get("/", async (c) => {
  const { fn, styled } = await tiny.imports(routeHandlers, routeStyles);

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

### Component scope

By default a style reaches down until the next styled element (every
`styled.*` class carries the `sb` boundary class). Use
`setCustomScope.toComponent(...)` to scope a style to the **component** instead:
it reaches through everything the component renders, including its other styled
elements, and stops at the root of any child component.

```tsx
const cardStyles = new tiny.Styles(import.meta.url, {
  card: setCustomScope.toComponent(css`
    padding: 16px;
    p { margin: 0; }            /* every <p> Card renders... */
    a { color: var(--accent); } /* ...but none inside child components */
  `),
  title: css`font-weight: 700;`,
});

export async function Card({ children }: PropsWithChildren) {
  const { styled } = await tiny.imports(cardStyles);
  return (
    <article class={styled.card}>
      <h3 class={styled.title}><a href="#">Link</a></h3>
      <Avatar /> {/* its own scope: Card's `a` and `p` rules stop here */}
      {children}
    </article>
  );
}
```

No wrapper is needed. The TinyTools JSX runtime marks the root element(s) of
every `<Component />` with `data-tc="<ComponentName>"`, which also shows the
component tree in devtools. Component-scoped styles end at `[data-tc]`.

- **Fragments** mark each top-level element.
- **Children passed in** (`props.children`) belong to the caller and are never
  marked, so a component that just returns `children` adds no boundary. Slot
  content rendered inside another component's element is outside the caller's
  donut, however. Style it with a class on the element itself.
- **Direct calls** such as `await SiteChrome({ children })` bypass JSX. Wrap the
  result: `return tiny.component(<div>...</div>, "SiteChrome")`.
- **Transparent components** render into the caller's scope. Opt out with
  `tiny.transparent(MyWrapper)`. Built-in components (`Partial*`, `Suspense`,
  `ClientRoutes`, ...) are transparent already.
- Both `"jsx": "react-jsx"` and `"jsx": "precompile"` are supported. Components
  returning raw strings from Hono's ``html`...` `` helper are not marked.

> **⚠️ Important:** Always declare `Handlers` and `Styles` instances at **module
> level** (outside of route handlers). This ensures handlers and styles are
> registered once at startup and included in the build. Creating them inside a
> route handler would re-register them on every request, causing performance
> issues and build inconsistencies.

## API Reference

### Core Module (`@tinytools/hono-tools`)

#### `tiny.middleware`

Core middleware supplies request context, asset tracking, rendering, and CSP.
Navigation, SSE listeners, client routes, and lifecycle behavior are activated
by importing handlers or rendering their components, not by feature middleware.

**`tiny.middleware.core(options?)`** - Core middleware array (CSP, context
storage, static file serving, JSX renderer, asset tracking). Spread into
`.use()`.

**`tiny.middleware.csp()`** - Sets the script CSP using the shared event
dispatcher hash. Included by default in `core()`; pass `{ csp: false }` to
preserve inline-handler behavior.

**`tiny.middleware.layout(renderFn)`** - Adds a layout wrapper for sub-routes.
Skips the callback on partial requests with a `source-url` header.

**`tiny.middleware.partialLayout(renderFn)`** - Uses the same layout
composition, but invokes the callback for both full-page and partial requests.
The callback receives `({ children }, c)` and can inspect
`c.req.header("source-url")` to decide whether to render a wrapper or return
children directly. Layouts render once; the root renderer awaits their output
before emitting asset tags.

```ts
import { Hono } from "hono";
import { tiny } from "@tinytools/hono-tools";

const app = new Hono().use(...tiny.middleware.core());
const equivalent = new tiny.Hono({ tools: "core" });
const plainSubroute = new tiny.Hono();
```

Core options include `csp`, `serveStatic`, `generatedFilenameHashLength`,
`generatedHandlerHashLength`, and `generatedStyleHashLength`. Hash lengths are
clamped to 1-8. `serveStatic` accepts the Hono adapter for your runtime.

#### `await tiny.imports(...tools)`

Import exactly the collections a route or component needs. The returned `fn`,
`events`, `handlers`, and `styled` are inferred from those collections; `c`
provides the current Hono request context. Each call is independent, and later
collections win when render-time imports contain the same name. Only accessed
handler/style assets are recorded for that request.

```tsx
async function Button() {
  const { fn, styled } = await tiny.imports(routeHandlers, routeStyles);
  return (
    <button class={styled.buttonStyle} onClick={fn.handleClick}>Click</button>
  );
}
```

`await tiny.imports()` with no arguments supplies request context and empty
tools. Explicit imports also work outside a request for update rendering, but
accessing `c` without an active request throws. No-argument imports require a
request. Handler factories require explicit imports and expose only `fn`.

#### Server-Sent Events

The server exports `addStream`, `removeStream`, `activeStreams`,
`trackConnectedClients`, path-query helpers, and `sendUpdateStream`. Register
your own SSE endpoint and opt into `trackConnectedClients` explicitly when
client/path tracking is needed. Core does not register an SSE endpoint or track
clients automatically.

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

#### Running Handlers on the Server

Use `.run` to execute a registered function directly on the server, with its
original argument and return types:

```tsx
const textHandlers = new tiny.Handlers(import.meta.url, {
  writeTextContent: function (value: string) {
    return value === "" ? "No text entered." : `Entered text: ${value}`;
  },
});

const output = <p>{textHandlers.run.writeTextContent("placeholder text")}</p>;
```

Object-form handlers are callable immediately. For factory-form handlers, first
await `textHandlers.ensureDefined()` or `tiny.imports(textHandlers)`; accessing
`.run` before definition readiness throws. `.run` itself does not build or mark
client assets as used and does not require a request context. Async handlers
still return promises; use `.call(receiver, ...args)` when a handler needs an
explicit `this`.

After initialization, returned factory handlers can call their imported `fn.*`
dependencies on the server too. Those dependencies remain private unless
explicitly exposed by the collection. Render-time `fn.*` values are still JSX
event references, not server-callable functions; legacy `getFunctionReferences`
values are still generated client references, not executable dependencies.

Only run functions whose dependencies are available on the server: `.run` does
not provide browser globals or serialize server state into the browser. Captured
mutable state, including factory-form `tiny.Store` state, belongs to the server
instance and can be shared across requests. Do not use it for request-specific
or per-user data. The name `run` is reserved for this API.

#### Async Handler Factories (Experimental)

`tiny.Handlers` accepts either a handler object or a synchronous or asynchronous
factory. Use `tiny.imports()` inside the factory to make other handlers
available as `fn`:

```ts
import { tiny } from "@tinytools/hono-tools";
import { signalTools } from "./signals.ts";

export const pageHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(signalTools);
  return {
    handleCommand: function (event: CommandEvent) {
      const values = fn.useSignal(event);
      console.log(values);
    },
  };
});
```

The factory runs once on the server when definitions are first needed. Returned
handler bodies are never executed during definition or building: they are
emitted as browser modules. Imports and full builds await definition readiness
automatically, including production and fresh builds.

- Pass multiple collections in one call: `await tiny.imports(toolA, toolB)`.
  Duplicate imported names and circular definition dependencies are errors.
- Only returned handlers are public. Here, components importing `pageHandlers`
  receive `handleCommand`, not `useSignal`.
- Static `fn.handlerName()` references are tree-shaken by esbuild. Used handlers
  remain separate, cacheable ESM files; unused dependencies are not loaded by
  the consumer. Dynamic `fn[name]` access or passing the whole namespace can
  retain all candidates. A full build still emits independently registered
  handlers.
- Keep the outer binding named `fn`. Original-name destructuring, such as
  `const { useSignal } = fn`, also works. Renamed outer bindings and arbitrary
  captured values are not serialized. Avoid identifier mangling in server builds
  that would rename those captured bindings.
- To forward an element receiver, use `fn.handlerName.call(this, event)`.
  Namespace calls do not automatically forward the current handler's `this`.
- Definition imports provide function references only, not request context,
  styles, event bindings, or rendering helpers. Calling these references in the
  outer factory throws; call them inside returned handlers instead.

The existing `tiny.Handlers` API remains supported. Prefer
`await tiny.imports()` when consuming an async collection. Synchronous
`getFunctionReferences` access before initialization throws; explicit setup code
can first await `pageHandlers.ensureDefined()` without building assets.

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
  const { fn } = await tiny.imports(localHandlers);
  return c.render(<button onClick={fn.handleClick}>Run</button>);
});
```

### Build Module (`@tinytools/hono-tools/build`)

#### Memory-Only Mode

Start the server with `--none` to generate handlers and scoped styles on demand
in memory, without writing generated files to `public/` or `.cache/`:

```sh
deno run --allow-net --allow-read --allow-env --allow-run main.tsx --none
```

Use `tiny.middleware.core()` or `new tiny.Hono({ tools: "core" })` as usual.
`tiny.imports(...)` prepares assets lazily, including handler dependencies. Core
serves them from memory at the usual `/handlers/` and `/styles/` URLs. No build
step is needed; `tiny.build()` and `buildScriptFiles()` reject in this mode.

The mode is process-wide and selected before modules load. `--none` takes
precedence over `--lazy` and ignores any existing disk cache. Without either
flag, the existing prebuilt-cache behavior is unchanged.

This avoids generated build files, not runtime compilation: esbuild is still
required (native or the existing WASM fallback). Runtime dependency installation
and caching are separate from TinyTools' generated assets. Package client
scripts and user-provided static assets must still be available to the runtime.
Standalone client TypeScript files are not transpiled by this mode.

Assets remain in process memory until restart. Restart to pick up source
changes; source mtimes are not checked. This suits small, long-lived instances
with read-only deployment filesystems. Each instance must render/import the
relevant tools before it can serve their assets, so independently routed
serverless asset requests need instance affinity or a prebuilt deployment.

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

#### `NewPartial`

Declarative partial page updates.

```tsx
import { NewPartial } from "@tinytools/hono-tools/components";
import { partialInsertHandlers } from "@tinytools/hono-tools/handlers";

const app = new Hono()
  .use(...tiny.middleware.core());

app.get("/profile", async (c) => {
  const { fn } = await tiny.imports(partialInsertHandlers);
  return c.render(
    <NewPartial
      id="user-profile"
      onLoad={fn.partialReplace}
    >
      <UserProfile />
    </NewPartial>,
  );
});
```

Available handlers are `partialReplace`, `partialDelete`, `partialBlast`, and
`partialMergeContent`. Every `NewPartial` requires an `onLoad` handler.

The server renders a `<template for-partial-id="...">` and a module-preload link
that dispatches its load event. Insertion handlers use `for-partial-id` to find
the live target and read incoming nodes from the template's content.

Set `cache` to `true` or a route pattern to opt into route caching. Set
`fullPageLoad` when rendering the initial page to render the content directly.

### Browser Dispatcher

Core includes the `tiny.runHandler` dispatcher inline on full page loads and
hashes that script in its CSP policy. The dispatcher imports handler modules
directly from `/handlers/`. There is no separate client entry point, package
client build, or generated client folder to watch. All other client behavior is
built into imported handlers.

## Type Safety

The package provides full TypeScript support with branded types for client
functions:

```tsx
// Imported references retain their handler signatures.
const { fn } = await tiny.imports(routeHandlers);
<button onClick={fn.handleClick}>Click</button>;

// Definitions must be imported before use in JSX.
const handlers = new tiny.Handlers(import.meta.url, {
  fn() {},
});
<button onClick={handlers.fn}>Click</button>; // Type error!
```

## License

MIT
