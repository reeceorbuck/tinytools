# @tinytools/hono-tools

A lightweight enhancement layer for [Hono](https://hono.dev/) web applications
running on Deno. Provides type-safe client functions, scoped styles, and
enhanced JSX event handlers.

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

## Installation

```ts
// deno.json
{
  "imports": {
    "@tinytools/hono-tools": "jsr:@tinytools/hono-tools@^0.1.0",
    "@tinytools/hono-tools/jsx-runtime": "jsr:@tinytools/hono-tools@^0.1.0/jsx-runtime",
    "@tinytools/hono-tools/build": "jsr:@tinytools/hono-tools@^0.1.0/build",
    "@tinytools/hono-tools/components": "jsr:@tinytools/hono-tools@^0.1.0/components"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@tinytools/hono-tools"
  }
}
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

const globalStyles = new tiny.Styles(import.meta.url, {
  appTheme: setCustomScope.unscoped(css`
    :root {
      color-scheme: light;
    }
  `),
}, { global: true });

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

> All scoped styles automatically include two additional scope limits:
> `[data-scope-boundary~="<generated-style-class>"]` and
> `[data-scope-boundary~="global"]`. The `~=` operator ensures exact token
> matching, so `global` does not match partial values like `my-global-theme`.

> **⚠️ Important:** Always declare `Handlers` and `Styles` instances at **module level**
> (outside of route handlers). This ensures handlers and styles are registered
> once at startup and included in the build. Creating them inside a
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

**`tiny.middleware.globalStyles(...styles)`** - Ensures
`globalStyles` assets are included on every request.

**`tiny.middleware.layout(renderFn)`** - Adds a layout wrapper for sub-routes.

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

const themedApp = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.sharedImports(globalHandlers))
  .use(tiny.middleware.globalStyles(...globalStyles.globalStyles));
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

> **\u26a0\ufe0f Always declare at module level** - `Handlers` and `Styles` instances must
> be created outside of route handlers so they are registered once at startup
> and included in the build process.

```ts
import { tiny, css } from "@tinytools/hono-tools";

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
  localHandler() {
    // ...
  },
}, { imports: [externalHandlers] });
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

- **Across separate instances**: use
  `otherTools.getFunctionReferences`, and ensure the calling instance includes
  the referenced tools in `imports: [...]`.
- **Within the same `Handlers` instance**: if one handler calls another,
  declare the referenced function at module scope (outside the constructor) and
  then assign it into the handlers, instead of only declaring it inline.

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

export const localHandlers = new tiny.Handlers(import.meta.url, {
  handleClick(this: HTMLElement, _e: MouseEvent) {
    externalFunction("called from handleClick");
    this.textContent = "done";
  },
  // Required when localHandlers calls functions from externalHandlers
}, { imports: [externalHandlers] });
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

> **Note:** The `Handlers`/`Styles` instance must still be declared at module level,
> outside the route handler. Only the `extendWithImports()` call happens inside
> the handler.

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

> **Note:** The `Handlers`/`Styles` instance must still be declared at module level.
> `getTools()` is for accessing tools inside components, not for declaring them.

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
    componentHandlers, componentStyles,
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

// Replace content
<Partial id="user-profile" mode="replace">
  <UserProfile user={user} />
</Partial>

// Merge content
<Partial id="message-list" mode="merge-content" new="append">
  <Message message={newMessage} />
</Partial>

// Update attributes only
<Partial id="submit-btn" mode="attributes" disabled="true" />
```

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
