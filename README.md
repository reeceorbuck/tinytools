# @tinytools/hono-tools

**Interactive server-rendered pages for [Hono](https://hono.dev/), without a
client framework.**

TinyTools lets you write the browser side of a page (event handlers, reactive
values, scoped CSS) right next to the JSX that uses it, in plain TypeScript. You
bind it in JSX the way you would in React, it is type-checked end to end, and
each page ships only the small, cached bundles it actually uses.

Published as `@tinytools/hono-tools` on JSR (Deno) and
`@tinyenterprise/hono-tools` on npm (Node.js and Bun).

## Why TinyTools

Server-rendered HTML is fast, simple and robust, until a page needs a little
interactivity. Then the usual choices are a separate pile of scripts that knows
nothing about your components, or a client framework that hydrates the whole
page. TinyTools takes a middle path:

- **Colocated.** A button's click handler and styles live in the same file as
  the component that renders it, as ordinary functions and `css` blocks.
- **Type-checked bindings.** `onClick={fn.save}` is checked like any prop: a
  handler written for `KeyboardEvent` is rejected on `onClick`, and Go to
  Definition jumps from the markup to the handler.
- **Ships only what a page uses.** Every collection compiles to its own
  content-hashed bundle. A page loads the bundles it binds and nothing else; a
  page with no handlers loads no script at all. Unchanged bundles stay cached
  forever.
- **No virtual DOM, no hydration.** The server renders real HTML. Handlers run
  against the elements you rendered, and reactive values update just the parts
  bound to them.
- **HTML first.** Links, forms and `<details>` keep working before any script
  runs. Partial navigation, streaming and live updates layer on top.
- **Strict CSP out of the box.** Scripts are same-origin and hash-allowed; no
  `unsafe-inline`.

## Install

### Deno

```sh
deno add jsr:@tinytools/hono-tools
```

TinyTools is also the JSX runtime, so point `jsxImportSource` at it:

```json
{
  "imports": {
    "tinytools": "jsr:@tinytools/hono-tools@^0.1.41",
    "tinytools/build": "jsr:@tinytools/hono-tools@^0.1.41/build",
    "tinytools/components": "jsr:@tinytools/hono-tools@^0.1.41/components",
    "tinytools/handlers": "jsr:@tinytools/hono-tools@^0.1.41/handlers",
    "tinytools/library": "jsr:@tinytools/hono-tools@^0.1.41/library",
    "tinytools/jsx-runtime": "jsr:@tinytools/hono-tools@^0.1.41/jsx-runtime",
    "tinytools/jsx-dev-runtime": "jsr:@tinytools/hono-tools@^0.1.41/jsx-dev-runtime",
    "esbuild": "npm:esbuild@^0.28.2",
    "hono": "jsr:@hono/hono@^4.13.13"
  },
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "tinytools",
    "lib": ["esnext", "deno.ns", "dom", "dom.iterable", "dom.asynciterable"]
  }
}
```

Handler code is checked against the DOM types, so keep `dom` in `lib`.

### Node.js and Bun

```sh
npm install @tinyenterprise/hono-tools hono
# Node.js only, for serving the generated assets:
npm install @hono/node-server
```

Import from `@tinyenterprise/hono-tools` (and its `/build`, `/components`,
`/handlers` and `/library` subpaths) in place of `tinytools`, and point
`jsxImportSource` at it in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "jsx": "react-jsx",
    "jsxImportSource": "@tinyenterprise/hono-tools",
    "lib": ["esnext", "dom", "dom.iterable"]
  }
}
```

Bun runs `.tsx` directly. Node.js (24 or later) strips types but does not
compile JSX, so run `.tsx` with a loader such as [tsx](https://tsx.is)
(`npx tsx server.tsx --lazy`). Handler bundles are built from the source the
runtime reports for each function, so build and serve with the same runtime.

## Quick start

### 1. A handler and some styles

```tsx
import { Hono } from "hono";
import { css, tiny } from "tinytools";

const buttonHandlers = new tiny.Handlers(import.meta.url, {
  greet(this: HTMLButtonElement) {
    this.textContent = "Hello!";
  },
});

const buttonStyles = new tiny.Styles(import.meta.url, {
  button: css`
    padding: 8px 16px;
    background: royalblue;
    color: white;
    &:hover {
      background: navy;
    }
  `,
});

const app = new Hono().use(...tiny.middleware.core());

app.get("/", async (c) => {
  const { fn, styled } = await tiny.imports(buttonHandlers, buttonStyles);
  return c.render(
    <button type="button" class={styled.button} onClick={fn.greet}>
      Say hello
    </button>,
  );
});

export default app;
```

`tiny.middleware.core()` serves the generated assets, sets the CSP header and
renders full documents. `tiny.imports()` records what the route used, so the
page links exactly one script and one stylesheet.

Declare collections at module level, never inside a route.

### 2. Reactive values, no handler code

`tiny.Signals` holds values the page reacts to. Bind them straight in JSX:

```tsx
const counter = new tiny.Signals(import.meta.url, { count: 0 });

app.get("/counter", async (c) => {
  const { signal } = await tiny.imports(counter);
  return c.render(
    <>
      <button type="button" onClick={signal.count}>Add one</button>
      <p>Clicked {signal.count} times.</p>
    </>,
  );
});
```

A click on a numeric signal adds one, and `{signal.count}` renders as live text.
Signals also bind to inputs (`onInput={signal.query.update}`), attributes and
properties (`checked={signal.open}`), and derive computed values from each
other.

### 3. A ready-made component

`tinytools/library` has accessible, signal-driven components: dialog, tabs,
popover, tooltip, combobox, command palette, date picker, carousel, steps,
selection, search filter, list and toasts. Place their parts anywhere and link
them with `instance()`:

```tsx
import { DialogSignalComponent } from "tinytools/library";

app.get("/profile", async (c) => {
  const { component } = await tiny.imports(DialogSignalComponent);
  const dialog = component.instance();
  return c.render(
    <>
      <dialog.Open>Edit profile</dialog.Open>
      <dialog.Panel label="Edit profile">
        <form method="post">
          <input name="name" />
          <button>Save</button>
        </form>
        <dialog.Close>Cancel</dialog.Close>
      </dialog.Panel>
    </>,
  );
});
```

### 4. Partial navigation

Bind the navigation handlers on `<body>` in a layout, and same-origin links and
forms fetch only the parts of the page that change:

```tsx
import {
  applyNavigationHandlers,
  navigationTools,
  processIncomingDataTools,
} from "tinytools/handlers";

app.use(tiny.middleware.layout(async ({ children }) => {
  const { fn } = await tiny.imports(
    applyNavigationHandlers,
    navigationTools,
    processIncomingDataTools,
  );
  return (
    <body
      onLoad={[fn.applyNavigationListener, fn.applyIncomingDataListener]}
      onNavigate={fn.handleNavigate}
      onIncomingData={fn.appendIncomingHtml}
    >
      <nav>
        <a href="/">Home</a> <a href="/counter">Counter</a>
      </nav>
      {children}
    </body>
  );
}));
```

The layout renders once; later navigations stream in just the route's content
and any new assets it needs.

## What else is in the box

- **Partials** (`tinytools/components`): replace, merge into or remove parts of
  the page from any response, with `Suspense` streaming for slow content.
- **Live updates**: track connected browsers by page and push rendered JSX to
  the ones showing affected content over server-sent events.
- **Navigation cache**: restore previously visited regions instantly, with their
  form state intact.
- **Lifecycle elements**: run handlers when an element connects, disconnects or
  finishes parsing.
- **Templates**: render markup once on the server and clone it in the browser.
- **Per-instance signals**: give each copy of a component its own state.
- **Builds**: prebuild every bundle for production, build on demand with
  `--lazy` in development, or serve from memory with `--none`.

## Documentation

A full documentation site is coming soon. Until then, every export carries
JSDoc, which you can browse on
[jsr.io](https://jsr.io/@tinytools/hono-tools/doc) or in your editor.

## License

MIT
