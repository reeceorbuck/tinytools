# @tiny-tools/hono

TinyTools is not a replacement for Hono.

It is a small layer on top of Hono's server-side JSX flow that adds a few extra
capabilities, with `ClientTools` as the core feature.

The goal is simple: keep writing normal server-rendered Hono apps, but gain:

- typed client event handlers written in TypeScript
- scoped CSS defined next to the JSX that uses it
- optional browser-side helpers for navigation and other framework-like features
- no client-side rendering system and no browser framework runtime

## What `ClientTools` does

`ClientTools` lets you define browser event handlers and scoped styles in the
same file as your Hono routes or components.

You write a function in TypeScript, attach it inline in JSX, and tinyTools takes
care of generating and serving the browser code behind it. The page is still
rendered on the server. There is no React-style hydration step and no
client-side component tree taking over after load.

That makes the mental model straightforward:

- Hono still renders the HTML
- your event handlers still feel like normal inline JSX handlers
- styles stay scoped to the markup that used them
- only the small client pieces that are actually needed get shipped

## Installation

```ts
// deno.json
{
  "imports": {
    "@tiny-tools/hono": "jsr:@tiny-tools/hono@^0.1.0",
    "hono": "jsr:@hono/hono@^4.12.7"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@tiny-tools/hono"
  }
}
```

## Quick Start

This is still just a Hono app. The only extra setup is adding the tinyTools
middleware and defining a `ClientTools` instance at module scope.

```tsx
import { Hono } from "hono";
import { ClientTools, css, tiny } from "@tiny-tools/hono";

const pageTools = new ClientTools(import.meta.url, {
  functions: {
    clickHandler(this: HTMLButtonElement, event: MouseEvent) {
      console.log("clicked", event);
      this.dataset.hue = `${Math.floor(Math.random() * 360)}deg`;
      this.textContent = "Clicked";
    },
  },
  styles: {
    button: css`
      --hue: attr(data-hue type(<angle>), 180deg);
      background: oklch(70% 0.18 var(--hue));
      color: white;
      border: 0;
      border-radius: 999px;
      padding: 0.7rem 1rem;
    `,
  },
});

const app = new Hono()
  .use(...tiny.middleware.clientTools());

app.get("/", async (c) => {
  const { fn, styled } = await pageTools.engage();

  return c.render(
    <button
      type="button"
      data-hue="180deg"
      class={styled.button}
      onClick={fn.clickHandler}
    >
      Click me
    </button>,
  );
});

Deno.serve(app.fetch);
```

That is the main idea of the package.

- `fn.clickHandler` is fully typed and safe to attach inline
- `styled.button` is a generated scoped class name
- the middleware handles the generated assets for the page

If you want a tools instance to be available across many routes, register it
once with middleware and read from `c.var.tools`:

```tsx
import { Hono } from "hono";
import { ClientTools, extendTools, tiny } from "@tiny-tools/hono";

const appTools = new ClientTools(import.meta.url, {
  functions: {
    save(this: HTMLButtonElement) {
      this.disabled = true;
      this.textContent = "Saved";
    },
  },
});

const app = new Hono()
  .use(...tiny.middleware.clientTools())
  .use(extendTools(appTools));

app.get("/", (c) => {
  const { fn } = c.var.tools;
  return c.render(<button onClick={fn.save}>Save</button>);
});
```

## Why it feels different

TinyTools aims to cover some of the jobs people often reach for a full-stack
framework to solve, but without introducing client-side rendering as the default
architecture.

The design bias is:

- server-render HTML first
- send small targeted client behavior when needed
- keep event handlers and styles close to the components that use them
- add progressive browser features without turning the app into a
  client-rendered SPA

## Optional feature modules

`ClientTools` is the main, most important feature. Everything below is optional
and currently less developed.

### `tiny.middleware.navApiTools()`

Adds Navigation API based page transitions and partial updates.

The intent is SPA-style navigation without building a client-rendered app. HTML
still comes from the server. tinyTools swaps the new server-rendered content
into the page instead of handing control to a browser framework.

This is one of the more ambitious parts of the package and should be treated as
evolving.

```ts
const app = new Hono()
  .use(...tiny.middleware.clientTools())
  .use(tiny.middleware.navApiTools());
```

### Other optional middleware

- `tiny.middleware.sseTools()` adds the package's Server-Sent Events client
  support
- `tiny.middleware.localRoutes()` adds local route matching helpers for
  navigation flows
- `tiny.middleware.webComponents()` adds small web-component based browser
  helpers
- `tiny.middleware.layout(...)` adds a route layout wrapper for server-rendered
  pages

### Optional components

- `Partial` is for server-driven partial page updates
- `Suspense` is for streaming async content with a fallback

These are useful building blocks, but they are still part of the developing side
of the package rather than the core day-one story.

## Build step

For development, handler and style assets can be generated lazily when they are
first used.

If you want an explicit build step for deployment or pre-generation, use the
build module:

```ts
import { buildScriptFiles } from "@tiny-tools/hono/build";

await buildScriptFiles();
```

## A few practical rules

- declare `ClientTools` instances at module scope, not inside route handlers
- use `fn` from `c.var.tools` or from `await tools.engage()` when attaching
  handlers in JSX
- treat tinyTools as an enhancement to normal Hono routing, not a separate
  framework
- start with `ClientTools`; add the other modules only when you actually need
  them

## Summary

If you want Hono to stay server-rendered but still feel ergonomic for
interactive UI, `ClientTools` is the reason to use this package.

The other modules are promising and useful, but they are still secondary. The
clearest way to understand tinyTools today is:

Hono first, tinyTools on top.
