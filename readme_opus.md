# @tinytools/hono-tools

Add client interactivity and scoped CSS to your [Hono](https://hono.dev/) + Deno
app — without shipping a client-side framework to the browser.

You still write a normal Hono application. Tiny Tools just gives you extra
capabilities on top.

## The idea

Hono already renders JSX on the server. **@tinytools/hono-tools** lets you
attach real event handlers and scoped styles to that server-rendered HTML. You
write the handler function, reference it inline in JSX with full TypeScript type
safety, and the framework takes care of the rest — extracting, bundling, and
lazy-loading only what's needed.

No virtual DOM, no hydration, no client-side rendering. The HTML is rendered on
the server, and tiny JS handler files are loaded on-demand when an event fires.

## Install

```jsonc
// deno.json
{
  "imports": {
    "@tinytools/hono-tools": "jsr:@tinytools/hono-tools@^0.1.0",
    "@tinytools/hono-tools/jsx-runtime": "jsr:@tinytools/hono-tools@^0.1.0/jsx-runtime",
    "hono": "jsr:@hono/hono@^4.12.7"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@tinytools/hono-tools"
  }
}
```

## Quick start

```tsx
import { Hono } from "hono";
import { ClientTools, css, tiny } from "@tinytools/hono-tools";

// Define your client-side handlers and styles at module level
const tools = new ClientTools(import.meta.url, {
  functions: {
    clickHandler(this: HTMLButtonElement, _ev: MouseEvent) {
      this.textContent = "Clicked!";
    },
  },
  styles: {
    buttonStyle: css`
      background: royalblue;
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
    `,
  },
});

// Create a standard Hono app with tiny middleware
const app = new Hono()
  .use(...tiny.middleware.core());

// Use handlers and styles in routes
app.get("/", async (c) => {
  const { fn, styled } = await tools.engage();
  return c.render(
    <button class={styled.buttonStyle} onClick={fn.clickHandler}>
      Click me
    </button>,
  );
});

Deno.serve(app.fetch);
```

That's it. The `clickHandler` function runs **in the browser** when clicked. The
scoped style is applied only where you use it. Neither requires a build step or
client-side framework — everything is handled automatically behind the scenes.

## How it works

1. **`ClientTools`** — declared at module level — defines the functions and
   styles you want available in the browser.
2. **`tiny.middleware.core()`** — sets up the Hono middleware (context storage,
   static file serving, JSX renderer).
3. **`tools.engage()`** — called inside a route handler or component — returns
   activated `fn` and `styled` proxies that are type-safe and ready to use in
   JSX.

Handler functions are extracted, bundled into tiny ES modules, and served as
static files. They are loaded lazily by the browser only when an event fires —
no upfront JS payload.

Scoped styles use native CSS `@scope` to prevent leaking. Each style is
automatically scoped to the element it's applied to.

## Core API

### `ClientTools`

The central building block. Declare at module level so handlers and styles are
registered once at startup.

```ts
const tools = new ClientTools(import.meta.url, {
  functions: {/* client-side event handlers */},
  styles: {/* scoped CSS styles */},
  imports: [/* other ClientTools instances to compose */],
});
```

- **`functions`** — each function runs in the browser. Use `this` typing to get
  the element reference.
- **`styles`** — use the `css` tagged template to define scoped CSS.
- **`imports`** — compose tools from other modules.

### `tools.engage()`

Call inside route handlers or components to get activated tools:

```ts
app.get("/", async (c) => {
  const { fn, styled } = await tools.engage();
  return c.render(<button onClick={fn.clickHandler}>Go</button>);
});
```

### `tools.extend(...otherTools).engage()`

Merge multiple `ClientTools` instances (e.g. local + shared):

```ts
const { fn, styled } = await localTools.extend(sharedTools).engage();
```

### `css`

Tagged template literal for defining CSS:

```ts
import { css } from "@tinytools/hono-tools";

const card = css`
  padding: 16px;
  border-radius: 8px;
`;
```

### `tiny.middleware`

Composable middleware — opt into only the features you need:

| Method             | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `core()`           | **Required.** Core context, static serving, JSX renderer. Spread into `.use()`. |
| `layout(renderFn)` | Wrap routes with a shared layout component.                                     |
| `navApiTools()`    | Client-side SPA navigation (see below).                                         |
| `sseTools()`       | Server-Sent Events support.                                                     |
| `localRoutes()`    | Client-side route matching.                                                     |
| `webComponents()`  | Lifecycle & window-event web components.                                        |
| `all()`            | Enable everything.                                                              |

### Composing tools across files

Tools can import from other `ClientTools` instances — useful for shared handlers
or a design system:

```ts
// shared.ts
export const sharedTools = new ClientTools(import.meta.url, {
  functions: {
    closeDialog(this: HTMLDialogElement) {
      this.close();
    },
  },
});

// page.ts
import { sharedTools } from "./shared.ts";

const pageTools = new ClientTools(import.meta.url, {
  imports: [sharedTools],
  functions: {
    submitForm(this: HTMLFormElement, e: SubmitEvent) {
      e.preventDefault();
      // ...
    },
  },
});
```

### Calling one client function from another

Use `getFunctionReferences` to get stable references that can be called inside
other handler bodies:

```ts
const { closeDialog } = sharedTools.getFunctionReferences;

const pageTools = new ClientTools(import.meta.url, {
  imports: [sharedTools],
  functions: {
    submitAndClose(this: HTMLFormElement, e: SubmitEvent) {
      e.preventDefault();
      closeDialog(); // calls the shared handler
    },
  },
});
```

## Build module

```ts
import { buildScriptFiles } from "@tinytools/hono-tools/build";

await buildScriptFiles(); // builds handlers + styles to public/
```

Pre-builds all registered handlers and styles to static files. Optional — the
framework also builds on-demand at request time with caching.

---

## Additional features (experimental)

The following features are under active development. They work but APIs may
change.

### Navigation API tools (`navApiTools`)

Enables SPA-style partial page updates using the browser's
[Navigation API](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API).
Instead of full page reloads, the server renders HTML and the client swaps in
only the parts that changed. No client-side router or rendering — all HTML still
comes from the server.

```ts
const app = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.navApiTools());
```

### Partial component

Declares regions of the page that can be independently updated:

```tsx
import { Partial } from "@tinytools/hono-tools/components";

<Partial id="user-info" mode="replace">
  <UserCard user={user} />
</Partial>;
```

Modes: `replace`, `delete`, `blast`, `merge-content`, `attributes`.

### Suspense component

Streaming content with a fallback while async content loads:

```tsx
import { Suspense } from "@tinytools/hono-tools/components";

<Suspense fallback={<p>Loading...</p>}>
  <AsyncContent />
</Suspense>;
```

### Server-Sent Events (`sseTools`)

Push real-time updates from the server to connected clients:

```ts
.use(tiny.middleware.sseTools())
```

### Web Components (`webComponents`)

Lifecycle and window-event listener web components for hooking into element
lifecycle without custom JS.

---

## License

MIT
