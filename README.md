# @tinytools/hono-tools

A lightweight enhancement layer for [Hono](https://hono.dev/) server-rendered
applications. TinyTools lets you write browser event handlers and scoped CSS
next to the server components that use them, binds them in JSX with full type
checking, and ships only the handler bundles and stylesheets a page actually
uses. On top of that it provides partial page updates, client-side navigation,
Suspense streaming and server-sent event updates, all driven by plain HTML.

Published as `@tinytools/hono-tools` on JSR (Deno) and
`@tinyenterprise/hono-tools` on npm (Node.js and Bun).

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Middleware and rendering](#middleware-and-rendering)
- [Event bindings](#event-bindings)
- [Handler collections](#handler-collections)
- [Signals](#signals)
- [Styles](#styles)
- [Components](#components)
- [Client-side navigation](#client-side-navigation)
- [Partial cache](#partial-cache)
- [Server-sent events](#server-sent-events)
- [Building and runtime modes](#building-and-runtime-modes)
- [Utilities](#utilities)
- [Diagnostics](#diagnostics)
- [Development](#development)

## Installation

### Deno (JSR)

```sh
deno add jsr:@tinytools/hono-tools
```

Or add the import map entries by hand. The package is also the JSX runtime, so
point `jsxImportSource` at it (not at `hono/jsx`):

```json
{
  "imports": {
    "tinytools": "jsr:@tinytools/hono-tools@^0.1.37",
    "tinytools/build": "jsr:@tinytools/hono-tools@^0.1.37/build",
    "tinytools/components": "jsr:@tinytools/hono-tools@^0.1.37/components",
    "tinytools/handlers": "jsr:@tinytools/hono-tools@^0.1.37/handlers",
    "tinytools/jsx-runtime": "jsr:@tinytools/hono-tools@^0.1.37/jsx-runtime",
    "tinytools/jsx-dev-runtime": "jsr:@tinytools/hono-tools@^0.1.37/jsx-dev-runtime",
    "esbuild": "npm:esbuild@^0.28.1",
    "hono": "jsr:@hono/hono@^4.12.32"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "tinytools",
    "lib": ["esnext", "deno.ns", "dom", "dom.iterable", "dom.asynciterable"]
  }
}
```

Both `"jsx": "react-jsx"` and Deno's `"jsx": "precompile"` are supported.
Handler code is type-checked against the DOM, so include `dom` in `lib`.

### Node.js and Bun (npm)

```sh
npm install @tinyenterprise/hono-tools
```

```ts
import { css, tiny } from "@tinyenterprise/hono-tools";
import { buildScriptFiles } from "@tinyenterprise/hono-tools/build";
import { NewPartial, Suspense } from "@tinyenterprise/hono-tools/components";
```

Install `@hono/node-server` as well on Node.js; it supplies the static file
adapter.

## Quick start

```tsx
import { Hono } from "hono";
import { css, tiny } from "tinytools";
import { buildScriptFiles } from "tinytools/build";

const buttonHandlers = new tiny.Handlers(import.meta.url, {
  handleClick(this: HTMLButtonElement, event: MouseEvent) {
    this.textContent = `Clicked (${event.type})`;
  },
});

const buttonStyles = new tiny.Styles(import.meta.url, {
  button: css`
    background: royalblue;
    color: white;
    padding: 8px 16px;
    &:hover {
      background: navy;
    }
  `,
});

const app = new Hono().use(...tiny.middleware.core());

app.get("/", async (c) => {
  const { fn, styled } = await tiny.imports(buttonHandlers, buttonStyles);
  return c.render(
    <button type="button" class={styled.button} onClick={fn.handleClick}>
      Click me
    </button>,
  );
});

// Optional: build every handler bundle and stylesheet before serving.
await buildScriptFiles();

export default app;
```

The page is rendered with a `<script type="module">` for the one handler bundle
it used, a `<link rel="stylesheet">` for the one style bundle, and the inline
`tiny.runHandler` dispatcher. Nothing else is loaded.

## Concepts

### Collections

Everything the browser needs is declared in **collections** at module level:

| Collection      | Holds                                  | Imported as |
| --------------- | -------------------------------------- | ----------- |
| `tiny.Handlers` | Functions that run in the browser      | `fn.*`      |
| `tiny.Signals`  | Reactive values shared across the page | `signal.*`  |
| `tiny.Styles`   | Scoped CSS blocks                      | `styled.*`  |

The first argument is `import.meta.url`. It tells the build which source file
owns the collection, so generated filenames stay stable across restarts and only
files whose source changed are rebuilt. Collections constructed without it are
rebuilt on every change and never cleaned up.

> **Declare collections at module level**, never inside a route handler.
> Creating them per request re-registers them on every request and breaks
> incremental builds.

### `tiny.imports()`

A route or component resolves exactly the collections it needs:

```tsx
const { fn, signal, styled, events, handlers, c } = await tiny.imports(
  handlersA,
  handlersB,
  styles,
);
```

- `fn.name` is a handler reference for JSX event attributes.
- `signal.name` is a signal reference, usable on `onLoad` / `onInput`.
- `styled.name` is the generated class string; `styled.mergeClasses(...)` joins
  class strings without duplicates.
- `events({...})` is an explicit attribute-spread alternative to `fn`.
- `handlers.name` is the legacy inline `onclick="..."` expression (blocked by
  the default CSP, kept for migration).
- `c` is the current Hono context; reading it outside a request throws.

Each call is independent. When several collections define the same name the last
one passed wins. Only the handler bundles and style bundles actually accessed
through `fn`, `signal`, `styled` or `events` are recorded for the request and
emitted by `AssetTags`.

`await tiny.imports()` with no arguments supplies the request context and empty
tools. Explicit imports also work outside a request (for example when rendering
a server-sent update), but then at least one collection must be passed.

### Bundles and filenames

Every collection compiles to one browser module at
`/handlers/<source>_<hash>.js`, exporting each handler by name. Elements
reference a handler as `tt-handler-click="<bundle>.<name>"`, and the inline
`tiny.runHandler` dispatcher imports the bundle on first use.

The hash covers the bundle's own code and every bundle it imports, directly or
indirectly. Editing a handler gives its bundle, and every bundle depending on
it, a new URL; unrelated bundles keep theirs and stay cached forever
(`Cache-Control: immutable`). Style bundles work the same way: one file per
`tiny.Styles` collection at `/styles/<source>_<hash>.css`.

## Middleware and rendering

### `tiny.middleware.core(options?)`

Spread into `.use()`. It installs, in order: the CSP header, memory-asset and
static file serving from `./public/`, Hono's context storage, per-request asset
tracking, and the JSX renderer. `new tiny.Hono({ tools: "core" })` is
equivalent; a plain `new tiny.Hono()` installs nothing.

| Option                        | Default       | Meaning                                                   |
| ----------------------------- | ------------- | --------------------------------------------------------- |
| `csp`                         | `true`        | Send the script CSP and use reference bindings (see CSP). |
| `serveStatic`                 | auto-detected | The static adapter for your runtime (Deno, Bun, Node).    |
| `generatedFilenameHashLength` | `5`           | Hash length for both handler and style filenames (1-8).   |
| `generatedHandlerHashLength`  | `5`           | Handler filename hash length.                             |
| `generatedStyleHashLength`    | `5`           | Style filename hash length.                               |

The renderer wraps `c.render(content, { title })` in a full document on normal
requests. When the request carries a `source-url` header (a partial navigation)
it instead returns an `<update>` document: a head section that imports any new
scripts and stylesheets and sets the title, followed by the rendered partials.

### Layouts

```tsx
const app = new tiny.Hono({ tools: "core" })
  .use(tiny.middleware.layout(async ({ children }, c) => {
    const { fn, styled } = await tiny.imports(chromeStyles, navigationTools);
    return (
      <body class={styled.shell} onNavigate={fn.handleNavigate}>
        <nav>...</nav>
        {children}
      </body>
    );
  }));
```

- `tiny.middleware.layout(callback)` wraps sub-routes on full-page requests and
  returns the children untouched on partial requests, so persistent shells are
  not re-sent.
- `tiny.middleware.partialLayout(callback)` calls the callback on partial
  requests too. The callback receives `({ children }, c)` and may return the
  children unchanged after inspecting `c.req.header("source-url")`.

Layouts render once. The root renderer awaits the layout's output before
emitting `AssetTags`, so assets used by asynchronous components inside the
layout are discovered. Engage a layout's own collections inside the callback (as
above) rather than behind a child component that is resolved later.

Because nested layouts are omitted on partial requests, a layout must not be the
only place that renders the `<NewPartial>` a partial response replaces. Put the
replacement target in route output, or have partial branches return explicit
partials (see the dental application for both patterns).

Recommended middleware order for a child router:

1. `...tiny.middleware.core()` (root router only)
2. feature middleware
3. `tiny.middleware.layout(...)`
4. routes or mounted child routers

### Content Security Policy

`core()` sends
`script-src 'self' 'sha256-…'; script-src-attr 'unsafe-hashes'
'sha256-…'`. The
two hashes cover the inline `tiny.runHandler` dispatcher and the shared
attribute body `tiny.runHandler(this,event)`, so every `fn.*` binding is allowed
while arbitrary inline scripts, legacy `handlers.*` attributes and cross-origin
scripts are blocked. The policy restricts scripts only.

`csp: false` sends no header and renders `fn.*` as legacy inline expressions for
the request. To manage your own policy, disable the default and include the hash
of the exported `eventHandlerBody` plus the dispatcher script:

```ts
import { eventHandlerBody } from "tinytools";
```

`tiny.middleware.csp()` is the standalone CSP middleware. Injected markup can
reuse an authorised attribute body, so keep sanitising untrusted HTML, including
`tt-handler-*` attributes.

## Event bindings

With TinyTools as the JSX runtime, handler references go straight on native
event attributes and keep Go to Definition and event-type checking:

```tsx
const { fn } = await tiny.imports(buttonHandlers);
<button onClick={fn.handleClick} onMouseOver={fn.handleHover} />;
```

A handler declared for `KeyboardEvent` is rejected on `onClick`. The runtime
expands each reference into `onclick="tiny.runHandler(this,event)"` plus
`tt-handler-click="<bundle>.handleClick"`. Components receive references
unchanged and can forward them to intrinsic elements; type such props with
`HandlerProp`:

```tsx
import type { HandlerProp } from "tinytools";

function Panel(props: { onLoad?: HandlerProp<(this: HTMLElement) => void> }) {
  return <section onLoad={props.onLoad} />;
}
```

Pass an array to run several handlers for one event, in order, without awaiting
each other:

```tsx
<body onLoad={[fn.applyNavigationListener, fn.activateSSE]} />;
```

Handlers receive the element as `this` and the native event as their argument.
Call `event.preventDefault()` before awaiting anything; returning `false` does
not cancel the default action.

`events()` is the explicit spread form and also accepts handler names from the
imported collections:

```tsx
const { fn, events } = await tiny.imports(buttonHandlers);
<button {...events({ click: fn.handleClick, mouseover: "handleHover" })} />;
```

Besides the standard DOM events, the JSX types cover `onCommand`, `onNavigate`,
`onCurrentEntryChange`, `onIncomingData` and `onSignal`. The `onMount` /
`onUnmount` attributes are deliberately unavailable; use the lifecycle
components instead.

## Handler collections

### Object form

```ts
export const listHandlers = new tiny.Handlers(import.meta.url, {
  select(this: HTMLLIElement, event: MouseEvent) { ... },
  clear(this: HTMLButtonElement) { ... },
});
```

Handlers in one collection can call each other by name. To use handlers from
another collection as bare identifiers, pass `{ imports: [other] }` as the
second argument.

### Factory form

A factory runs once on the server when the collection is first needed and
returns the handlers. Use `tiny.imports()` inside it to make other collections
available as `fn`:

```ts
export const pageHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn } = await tiny.imports(queryParamTools);
  return {
    handleChange(this: HTMLElement, event: NavigationCurrentEntryChangeEvent) {
      const changes = fn.queryParamChanges(event.from.url);
      ...
    },
  };
});
```

Rules for factory code, which is emitted as a browser module:

- Keep the outer binding named `fn` (or destructure the original names, such as
  `const { queryParamChanges } = fn`). Renamed bindings and arbitrary captured
  values are not serialised.
- Static `fn.name()` references are tree-shaken by esbuild, so unused
  dependencies are not loaded. Dynamic `fn[name]` access retains them all.
- Forward a receiver explicitly: `fn.other.call(this, event)`.
- Definition imports give function references only, not request context or
  styles. Calling them in the outer factory throws; call them inside the
  returned handlers.
- Only returned handlers are public. Duplicate imported names and circular
  definition dependencies are errors.

Factory bodies never run during definition or building. Imports and full builds
await definition readiness automatically.

### Running handlers on the server

`collection.run.name(...)` calls a registered function directly on the server
with its original types:

```tsx
const text = new tiny.Handlers(import.meta.url, {
  describe(value: string) {
    return value === "" ? "No text entered." : `Entered: ${value}`;
  },
});

<p>{text.run.describe("draft")}</p>;
```

Factory-form collections must be defined first
(`await
collection.ensureDefined()` or `tiny.imports(collection)`). `run`
neither builds assets nor needs a request context. Only run functions whose
dependencies exist on the server; browser globals are not provided.

## Signals

`tiny.Signals` declares reactive values from a pure, synchronous factory:

```ts
const viewerSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed }) => {
    const setContrast = new Signal(0);
    const contrast = new Computed(() => 10 ** Number(setContrast.value), [
      setContrast,
    ]);
    contrast.name = "contrast-adjust";
    return { setContrast, contrast };
  },
);
```

- Initial values are string, number, boolean or `null` (the default). Values
  written from input events are strings, so convert in computed callbacks.
- `Computed` is read-only and updates synchronously when its listed dependencies
  change. Equal values do not notify.
- The factory runs on the server to validate the definitions and again in the
  browser. Keep it pure: no outer captures, imports, async work or
  `tiny.imports()`. Read and write `.value` only in computed callbacks or
  handlers.
- Every collection shares one signal runtime module; each collection is one
  bundle whose state is shared by all consumers on the page.

In handlers, import a collection and use `signal.name.value` directly. In JSX,
`signal.name` is an event reference:

```tsx
const { fn, signal } = await tiny.imports(viewerSignals, signalTools);

<input type="range" onInput={signal.setContrast} />;
<dialog onLoad={signal.contrast} onSignal={fn.setCssProperty} />;
```

- On `input` / `change` the signal takes the target's value and, if the input
  has a `name` (or `data-bind-name`), that name.
- On `load` the element subscribes to the signal and receives `signal` events
  (`event.signal.value`) whenever it changes. Subscriptions use the element's
  `abortController` when present (see `UpgradeCustomElement`), so they end when
  the element is removed.
- While rendering, a reference exposes no `.value`; reading it throws.
- `value={signal.x}` is not a binding. Render the initial value yourself.

To render initial markup with the same computations, evaluate the collection on
the server. `evaluateUsingInitialValues` runs the factory with the given values
written to its writable signals and returns every signal's value:

```tsx
const { contrast } = viewerSignals.evaluateUsingInitialValues({
  setContrast: 0.5,
});
<output onLoad={signal.contrast} onSignal={fn.setTextContent}>
  {contrast}
</output>;
```

Each call builds a fresh graph, so nothing is shared between requests. Signals
left out keep their initial values, computed signals cannot be passed as inputs,
and a computed callback that needs browser globals throws when evaluated.

The `signalTools` collection from `tinytools/handlers` provides `effect`,
`setTextContent`, `setValue` and `setCssProperty` (which writes
`--<signal name>`).

### Per-instance signals

When a component renders several times on a page (for example each layer of a
repeated fieldset), wrap its signals in `perInstance`. The callback describes
one instance and runs once per instance root, so signals and computeds inside it
see only that instance:

```tsx
const layerSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed, perInstance }) => {
    const layer = perInstance(() => {
      const material = new Signal<string>("composite");
      const shade = new Signal<string>("A2");
      const description = new Computed(
        () => `${material.value} ${shade.value}`,
        [material, shade],
      );
      return { material, shade, description };
    });
    return {
      ...layer,
      summary: new Computed(
        () => layer.description.all.value.join("; "),
        [layer.description.all],
      ),
    };
  },
);

<fieldset tt-instance={layerSignals.instanceKey}>
  <select onChange={signal.material}>...</select>
  <select onLoad={signal.material} onSignal={fn.applyMaterial}>...</select>
</fieldset>;
```

- Set `tt-instance={collection.instanceKey}` on the element wrapping each
  instance. References inside it (`onChange`, `onLoad`) resolve to that
  instance, so consuming elements need no extra attributes. Using one outside a
  root throws.
- Roots of different collections can nest. One element can root several
  collections by listing their keys separated by spaces.
- In handlers, `signal.material.for(this)` is the signal of the instance
  enclosing `this`. A per-instance signal has no single `.value`.
- `signal.x.all` is a read-only signal of every instance's value in document
  order. It updates when any instance changes and when roots are added or
  removed, so a `Computed` depending on it is the net result of all instances.
- Signals outside `perInstance` stay page-wide, and collections without it work
  as before.
- `evaluateUsingInitialValues` reports a fresh instance's value for per-instance
  signals, sees no instances for `.all`, and does not accept them as inputs.

#### Nested instances

When instances contain instances (several open forms, each with its own layers),
nest a named `perInstance` inside another. The inner callback runs once per
inner root within each outer instance, so its `.all` covers only that outer
instance, and its computeds can read the outer instance's signals:

```tsx
const noteSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed, perInstance }) => {
    const note = perInstance(() => {
      const isolation = new Signal<string>("rdam");
      const layer = perInstance("layer", () => {
        const material = new Signal<string>("composite");
        return {
          material,
          label: new Computed(() => `${material.value} (${isolation.value})`, [
            material,
            isolation,
          ]),
        };
      });
      return {
        isolation,
        ...layer,
        summary: new Computed(
          () => layer.label.all.value.join("; "),
          [layer.label.all],
        ),
      };
    });
    return { ...note };
  },
);

<form tt-instance={noteSignals.instanceKey}>
  <select onChange={signal.isolation}>...</select>
  <fieldset tt-instance={noteSignals.instanceKeyFor("layer")}>
    <select onChange={signal.material}>...</select>
  </fieldset>
  <output onLoad={signal.summary} onSignal={fn.setTextContent} />
</form>;
```

- A nested `perInstance` needs a name. Its roots carry `instanceKeyFor(name)`;
  unnamed top-level roots carry `instanceKey`. `instanceKeyFor` only accepts
  names whose signals the factory returns, so a typo fails type checking.
- Signals resolve level by level: `signal.material.for(this)` finds the
  enclosing form, then the layer inside it. A layer signal used outside a layer
  root throws.
- Read a nested signal's `.all` inside the enclosing `perInstance`, where it is
  scoped to that instance. Outside it, `signal.material.all` throws.

## Styles

`css` is a template tag that normalises whitespace; `tiny.Styles` turns each
block into a hashed class name and emits it inside an `@scope` rule:

```ts
const cardStyles = new tiny.Styles(import.meta.url, {
  card: css`
    padding: 16px;
    h3 {
      margin: 0;
    }
  `,
});
```

Generated CSS is layered as
`@layer global, unscoped, limited, normal,
important, debug`, declared by the
core renderer in `<head>`.

### Scope modes

| Helper                                   | Reaches                                                               | Layer      |
| ---------------------------------------- | --------------------------------------------------------------------- | ---------- |
| plain `css`, `setCustomScope.toBoundary` | Down to the next styled element (every `styled.*` class carries `sb`) | `normal`   |
| `setCustomScope.toComponent`             | Everything the component renders, stopping at child component roots   | `normal`   |
| `setCustomScope.toSelectors(css, [...])` | Down to elements matching the selectors                               | `limited`  |
| `setCustomScope.unscoped`                | Unlimited                                                             | `unscoped` |
| `setCustomScope.direct`                  | Content emitted directly inside `@scope` (for `@keyframes` etc.)      | `normal`   |

Every helper accepts `{ layer }` to override the layer. All scoped styles also
stop at `[data-scope-boundary~="<generated class>"]` and
`[data-scope-boundary~="global"]`, so an element can end a scope by hand;
`collection.generatedStyleNames.get("card")` gives the class without a request
context.

### Component scope

The JSX runtime marks the root element(s) of every `<Component />` with
`data-tc="<ComponentName>"`. `toComponent` styles end at `[data-tc]`:

- Fragments mark each top-level element.
- Children passed in through `props.children` belong to the caller and are never
  marked.
- Components called as plain functions bypass JSX; wrap their output with
  `tiny.component(jsx, "Name")`.
- `tiny.transparent(Component)` opts a wrapper out so it renders in the caller's
  scope. The built-in components are transparent.
- Components returning raw `html` strings are not marked.

Keep `Styles` collections beside the components that use them. Generated bundle
names keep the source module name, so emitted assets are easy to inspect, and a
style file is only loaded on pages that access one of its classes.

## Components

Import from `tinytools/components`.

### `Suspense`

```tsx
<Suspense fallback={<p>Loading…</p>}>
  <SlowComponent />
</Suspense>;
```

Streams the fallback immediately and the resolved content afterwards, as a
partial that replaces the fallback in place. Assets first used by streamed
content are imported with the chunk. `CustomSuspense` takes an `onLoad`
insertion handler for other replacement strategies.

### Partials

A partial is a `<template for-partial-id="...">` plus a modulepreload link whose
`load` event runs the insertion handler. The browser applies it to the live
element with that id.

```tsx
import {
  NewPartial,
  PartialDelete,
  PartialReplace,
} from "tinytools/components";
import { partialInsertHandlers } from "tinytools/handlers";

<PartialReplace id="results">
  <ResultsList />
</PartialReplace>;

<PartialReplace id="card-7" includeWrapper>
  <Card id={7} />
</PartialReplace>;

<PartialDelete id="card-7" />;

const { fn } = await tiny.imports(partialInsertHandlers);
<NewPartial
  id="list"
  onLoad={fn.partialMergeContent}
  existing="substitute"
  new="append"
>
  <li id="item-3">...</li>
</NewPartial>;
```

| Handler               | Effect                                                         |
| --------------------- | -------------------------------------------------------------- |
| `partialReplace`      | Replaces the children of `#id`                                 |
| `partialBlast`        | Replaces `#id` itself (`PartialReplace` with `includeWrapper`) |
| `partialDelete`       | Removes `#id`                                                  |
| `partialMergeContent` | Merges each child into `#id` by id or group (attributes below) |

`partialMergeContent` matches each incoming child against an existing child with
the same `id` (or `match-id`), then by `group-name` / `data-partial-group`. The
`existing` and `group` attributes choose `substitute`, `match`,
`substitute(append)`, `match(append)`, `substitute(prepend)` or
`match(prepend)`; `new` chooses `append`, `prepend` or `ignore` for children
with no match.

`fullPageLoad` renders the children in place without the template, for layouts
that already place the content inside its target on a full page load.

### Lifecycle components

Browsers only fire `load` on a few elements. These wrappers give any element
lifecycle events:

- `<UpgradeCustomElement>` upgrades each child to a custom element whose
  `onLoad` runs whenever it connects (including after cached restoration), whose
  `onDisconnect` runs when it is removed, and whose `abortController` aborts on
  removal so handlers can register listeners that clean themselves up. Prefer
  this with a hyphenated tag (`<load-more>`): the tag is defined by name, so it
  keeps working however the element is moved, substituted or cloned. Since
  `onLoad` can run more than once, guard one-time setup. Elements without a
  hyphenated tag get a proxy sibling instead, which must stay next to them.
- `<ActivateOnLoadHandler>` runs each child's `onLoad` once, via a trigger
  placed right after it. The trigger acts on its previous sibling, so content
  that moves the element away from it (such as a partial substituting it in a
  list) can fire the handler on the wrong element. Prefer `UpgradeCustomElement`
  with a custom tag.
- `<BuildFromTemplateElement templateId="...">` clones a page `<template>` into
  the element and fills its named `<slot>`s from the children.

### `ClientRoutes`

`ClientRoutes` renders local content when a navigation matches a `client-route`,
before (or instead of) the server response:

```tsx
<ClientRoutes>
  <client-route path="/patients/:id" query="tab=notes&preview=*">
    <PartialReplace id="panel">Loading notes for $[id]…</PartialReplace>
  </client-route>
  <client-route path="/help/:topic" query="" data-nav-block>
    <PartialReplace id="panel">Help topic: $[topic]</PartialReplace>
  </client-route>
</ClientRoutes>;
```

Paths use `URLPattern` syntax. All matching routes render in declaration order.
`data-nav-block` suppresses the server fetch; without it local content acts as a
loading state. Routes default to `method="get"`; use `method="post"` for
submission states, where submitted form values also fill placeholders.

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

AND binds tighter than OR. Keys and values use query decoding; encode literal
`&` and `|` as `%26` and `%7C`. Invalid rules disable the route with a console
warning.

`$[name]` placeholders in text and attributes receive path captures, decoded
query values (which override captures) and, for POST routes, form values.
Replacement is literal and single-pass, applied through DOM text and attribute
APIs, so values are never parsed as HTML. It is not a URL or script sanitiser:
do not interpolate untrusted values into event handlers, scripts, styles or
unconstrained URL attributes.

Other attributes: `once` moves the authored nodes instead of cloning and removes
the route; `fallback` suppresses a loading route when another matching route
blocks the fetch; `interpolate="false"` renders literally; `data-nav-redirect`
keeps or sets the displayed URL like the attribute on a link.

### `AssetTags`

Renders the script, modulepreload and stylesheet tags for the assets a render
accessed. The core renderer places it for you; use it directly only in custom
renderers.

## Client-side navigation

Navigation is opt-in and attribute driven. Register the handlers from
`tinytools/handlers` on `<body>`:

```tsx
const { fn } = await tiny.imports(
  applyNavigationHandlers,
  navigationTools,
  processIncomingDataTools,
);

<body
  onLoad={[
    fn.applyNavigationListener,
    fn.applyCurrentEntryChangeListener,
    fn.applyIncomingDataListener,
  ]}
  onNavigate={fn.handleNavigate}
  onCurrentEntryChange={fn.setVariablesFromUrl}
  onIncomingData={fn.appendIncomingHtml}
  style={urlStyleVariables(c.req.url)}
>
```

`handleNavigate` intercepts same-origin navigations through the Navigation API,
fetches the destination with the headers `partial-nav: true`, `source-url` (the
current page) and `destination-url`, and streams the `<update>` response into
the page. Rapid GET requests to the same path abort earlier ones.

| Attribute (link, form or submit button) | Effect                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| `data-nav-partial="/api/path"`          | Fetch this URL instead of the destination (query copied if absent) |
| `data-nav-redirect`                     | Keep the current URL after navigating                              |
| `data-nav-redirect="/path"`             | Display this URL after navigating                                  |
| `data-no-intercept`                     | Let the browser navigate normally                                  |
| `data-local-only`                       | Run client routes but skip the server fetch                        |

Responses may set `X-spa-redirect: /path` to update the displayed URL without
another fetch; this is also recorded by `trackConnectedClients`. Empty query
parameters are dropped from the displayed URL on push navigations.

Incoming HTML is split on `</update>` and dispatched as `incomingdata` events
(`{ type: "html", element, paths }` or `{ type: "json", data }`).
`appendIncomingHtml` applies partials when the update has no `update-paths` or
one of them matches the page path or a cached region's `update-path`; head
imports are always applied. Non-update HTML is shown in a
`<dialog id="global-modal">` when the page has one.

## Partial cache

Opt a replacement partial into the template-based navigation cache:

```tsx
<PartialReplaceWithCache id="panel" fullPageLoad={!c.req.header("source-url")}>
  <PatientDetails />
</PartialReplaceWithCache>;
```

When the target's children are replaced, a `MutationObserver` moves the outgoing
nodes into a `client-route` with `once`, `data-nav-block` and
`interpolate="false"` published in a cache router beside the target. A later
navigation whose fetch URL matches restores the nodes with their identity, form
values and listeners intact, without a server fetch.

- `cache={true}` (the default for `PartialReplaceWithCache`) matches the exact
  request path; `path="/patients{/:id}?"` supplies a `URLPattern`. Queries and
  hashes are ignored. A restore blocks the whole fetch, so choose patterns whose
  stored content suffices.
- `updatePath` names the page path that server updates are matched against while
  the content is cached (defaults to the page the request was displayed under).
- Capture depends on DOM replacement, not on the navigation. Nested regions
  suspend and resume their observers when a parent is removed or restored.
- POST, URL-only and non-intercepted navigations do not restore cached routes.
  Eviction is not implemented.

## Server-sent events

The server exports stream tracking so updates reach only the clients showing
affected content:

```ts
import {
  addStream,
  removeStream,
  SSE_ID_COOKIE,
  trackConnectedClients,
} from "tinytools";

app.use(trackConnectedClients);

app.get("/sse", (c) => {
  const id = getCookie(c, SSE_ID_COOKIE)!;
  return streamSSE(c, (stream) => {
    addStream({ id, userName, userAgent, stream });
    return new Promise((resolve) =>
      stream.onAbort(() => {
        removeStream(stream);
        resolve();
      })
    );
  });
});
```

`trackConnectedClients` assigns each browser an `HttpOnly` `sseId` cookie and
records the page path each response is displayed under (`/api/` requests use
their `destination-url`). `getStreamsMatchingPaths(patterns)` returns the
streams that visited a matching page; `streamEvents` emits `streamAdded`,
`streamUpdated` and `streamRemoved`.

`sendUpdateStream(jsx, streams, { paths })` renders JSX as an `<update>`
document and writes it to every stream, including a head section for any assets
the content uses. With `paths`, the client applies the partials only to a page
or cached region matching one of the patterns. In the browser,
`sseTools.activateSSE` (bind to `<body onLoad>`) opens `/sse` and feeds messages
through `processIncomingData`.

## Building and runtime modes

```ts
import { buildScriptFiles } from "tinytools/build";

await buildScriptFiles({
  publicDir: "./public",
  handlerDir: "./public/handlers",
  stylesDir: "./public/styles",
  fresh: false,
  transpileClientFiles: false,
  clientDir: "./client",
});
```

`buildScriptFiles()` (also `tiny.build()`) defines every registered collection,
writes every handler bundle and style bundle, removes stale files and persists
`.cache/clientToolsCache.json`. `fresh: true` skips every cache and existence
check, for isolated deployments. `transpileClientFiles` transpiles standalone
`.ts` files from `clientDir` into `publicDir`.

Three process-wide modes are selected by command-line flags:

| Mode | Flag     | Behaviour                                                                                    |
| ---- | -------- | -------------------------------------------------------------------------------------------- |
| prod | (none)   | Trusts the cache; nothing is built during requests. Falls back to lazy without a cache.      |
| lazy | `--lazy` | `tiny.imports()` builds or revalidates the collections it needs, on demand, by source mtime. |
| none | `--none` | Assets are generated in memory and served from it; nothing is written to disk.               |

Use lazy mode with a file watcher during development and run a build before
starting in prod mode. Running a build while a watcher is rebuilding can race on
the cache file; stop the watcher first. In none mode, builds reject and each
instance must render a collection before it can serve its assets.

Add `.cache/`, `public/handlers/` and `public/styles/` to your ignore file.

## Utilities

- `titled(title, handler)` attaches a title to a route handler. The core
  renderer uses it as the document title and partial responses include it in the
  head update; `handler.title` is also readable for building navigation.
- `urlStyleVariables(url)` returns an inline style declaring `--path-<index>`
  and `--param-<key>` custom properties. Together with `fn.setVariablesFromUrl`
  on `onCurrentEntryChange`, CSS can react to the URL (for example
  `@container style(--path-1: 42)`) with no handler code.
- `queryParamTools.queryParamChanges(fromUrl)` returns a map of changed query
  parameters between a previous URL and the current entry.
- `logStartupPerformanceSummary()` prints a startup breakdown. Place marks named
  `startup:importsComplete` and `startup:routesRegistered`, plus
  `import:<name>:done` after costly imports and `import:route:<name>:start` /
  `:end` around route imports, to see them in the summary.

## Diagnostics

A route can pass type checks, builds and full-page checks while partial
navigation remains unstyled. For routes with their own styles, test the
sequence: load a different route, navigate with client navigation, confirm new
`/styles/*.css` links were added to `<head>`, and check one meaningful computed
style. When styles appear missing, verify in order that the scoped class is in
the returned HTML, the bundle exists under `public/styles`, the full page links
it, the `<update>` head links it, and the browser appended the link.

Private fields such as `_styleFilenames` and `_styles` are internal; register
styles through `tiny.imports()` rather than reading them.

## Development

From the package directory:

```sh
deno task check   # type-check the public entry points
deno task lint
deno task test    # full test suite (writes under ./.test-* and ./public)
```

`tests/fixtures/events-csp.tsx` is a runnable comparison of legacy and reference
bindings: `deno run -A tests/fixtures/events-csp.tsx` and open
`http://127.0.0.1:3047/` (add `?csp` to enable the policy).

Publishing is driven from the workspace root (`deno task release:patch`), which
bumps the version, publishes to JSR, syncs `package.json` and updates the
consumers' pins.

## License

MIT
