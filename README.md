# @tiny-tools/hono

A lightweight enhancement layer for [Hono](https://hono.dev/) web applications
running on Deno. Provides type-safe client functions, scoped styles, and
enhanced JSX event handlers.

## Features

### Core Features

- **ClientTools** - Unified factory for type-safe client-side event handlers and
  scoped CSS styles
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
    "@tiny-tools/hono": "jsr:@tiny-tools/hono@^0.1.0",
    "@tiny-tools/hono/jsx-runtime": "jsr:@tiny-tools/hono@^0.1.0/jsx-runtime",
    "@tiny-tools/hono/build": "jsr:@tiny-tools/hono@^0.1.0/build",
    "@tiny-tools/hono/components": "jsr:@tiny-tools/hono@^0.1.0/components"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "@tiny-tools/hono"
  }
}
```

## Quick Start

```tsx
import { Hono } from "hono";
import {
  addTinyTools,
  ClientTools,
  css,
  extendTools,
  setCustomScope,
} from "@tiny-tools/hono";
import { buildScriptFiles } from "@tiny-tools/hono/build";

// Define client-side event handlers and styles together
const buttonStyle = css`
  background: blue;
  color: white;
  padding: 8px 16px;
  border-radius: 4px;
  &:hover {
    background: darkblue;
  }
`;

const tools = new ClientTools(import.meta.url, {
  functions: {
    handleClick(this: HTMLButtonElement, e: MouseEvent) {
      console.log("Clicked!", e);
      this.textContent = "Clicked!";
    },
    handleSubmit(this: HTMLFormElement, e: SubmitEvent) {
      e.preventDefault();
      console.log("Form submitted!");
    },
  },
  styles: {
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
  },
  globalStyles: { // TODO: globalStyles would always be unscoped
    appTheme: setCustomScope.unscoped(css`
      :root {
        color-scheme: light;
      }
    `),
  },
});

// Create Hono app with tools using middleware
const app = new Hono()
  .use(...addTinyTools())
  .use(extendTools(tools));

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

> **⚠️ Important:** Always declare `ClientTools` instances at **module level**
> (outside of route handlers). This ensures handlers and styles are registered
> once at startup and included in the build. Creating `ClientTools` inside a
> route handler would re-register them on every request, causing performance
> issues and build inconsistencies.

## API Reference

### Core Module (`@tiny-tools/hono`)

#### `addTinyTools()`

Returns an array of middleware that sets up TinyTools infrastructure including
static file serving, context storage, JSX renderer, and empty tools
initialization.

```ts
import { Hono } from "hono";
import { addTinyTools, ClientTools, extendTools } from "@tiny-tools/hono";

const tools = new ClientTools(import.meta.url, {
  functions: {
    handleClick() {
      console.log("clicked");
    },
  },
});

const app = new Hono()
  .use(...addTinyTools())
  .use(extendTools(tools));
```

#### `extendTools(tools)`

Creates middleware that extends the current tools context with additional
ClientTools. Use this to add route-specific or app-level tools.

```ts
import { Hono } from "hono";
import { addTinyTools, ClientTools, extendTools } from "@tiny-tools/hono";

const globalTools = new ClientTools(import.meta.url, {
  functions: {
    globalHandler() {
      console.log("global");
    },
  },
});

const app = new Hono()
  .use(...addTinyTools())
  .use(extendTools(globalTools));
```

#### `withAncestors<T>`

Type helper for declaring ancestor tools in child routes. This provides type
safety when accessing tools from parent routes.

```ts
import { Hono } from "hono";
import { ClientTools, extendTools, withAncestors } from "@tiny-tools/hono";
import type { globalTools } from "./main.tsx";
import type { parentTools } from "./parent.tsx";

const localTools = new ClientTools(import.meta.url, {
  functions: {
    localHandler() {
      console.log("local");
    },
  },
});

// Child route with ancestor type declarations
export const childRoute = new Hono<
  withAncestors<[typeof parentTools, typeof globalTools]>
>()
  .use(extendTools(localTools))
  .get("/", (c) => {
    const { fn } = c.var.tools;
    // Has access to: localHandler, parentTools handlers, globalTools handlers
    return c.render(<div onClick={fn.localHandler}>Click</div>);
  });
```

#### `ClientTools`

Unified factory for creating type-safe client-side event handlers and scoped CSS
styles.

> **\u26a0\ufe0f Always declare at module level** - `ClientTools` instances must
> be created outside of route handlers so they are registered once at startup
> and included in the build process.

```ts
import { ClientTools, css } from "@tiny-tools/hono";

const myStyle = css`
  color: blue;
  padding: 16px;
`;

// ✅ Correct: declared at module level
const tools = new ClientTools(import.meta.url, {
  functions: {
    handlerName(this: HTMLElement, e: Event) {
      // Handler code runs in the browser
    },
  },
  styles: { myStyle },
});

// Import handlers and styles from other files
const combined = new ClientTools(import.meta.url, {
  imports: [externalTools],
  functions: {
    localHandler() {
      // ...
    },
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

- **Across separate `ClientTools` instances**: use
  `otherTools.getFunctionReferences`, and ensure the calling instance includes
  the referenced tools in `imports: [...]`.
- **Within the same `ClientTools` instance**: if one handler calls another,
  declare the referenced function at module scope (outside the constructor) and
  then assign it into `functions`, instead of only declaring it inline.

##### Across separate `ClientTools` instances (including different files)

```ts
import { ClientTools } from "@tiny-tools/hono";

const externalTools = new ClientTools(import.meta.url, {
  functions: {
    externalFunction(msg: string) {
      console.log("external", msg);
    },
  },
});

// Module-level reference for composition inside another client function
const { externalFunction } = externalTools.getFunctionReferences;

export const localTools = new ClientTools(import.meta.url, {
  // Required when localTools calls functions from externalTools
  imports: [externalTools],
  functions: {
    handleClick(this: HTMLElement, _e: MouseEvent) {
      externalFunction("called from handleClick");
      this.textContent = "done";
    },
  },
});
```

##### Within the same `ClientTools` instance

```ts
import { ClientTools } from "@tiny-tools/hono";

// Declare at module scope so other handlers can reference it safely. Must be defined in the same file.
const sharedHandler = function (this: HTMLElement, e: MouseEvent) {
  console.log("shared", this, e);
};

export const tools = new ClientTools(import.meta.url, {
  functions: {
    sharedHandler,
    nestedHandler: function (this: HTMLElement, e: MouseEvent) {
      sharedHandler.call(this, e);
    },
  },
});
```

Use `fn.*` only when attaching handlers in JSX/render code:

```tsx
app.get("/", (c) => {
  const { fn } = c.var.tools.extend(localTools);
  return c.render(<button onClick={fn.handleClick}>Run</button>);
});
```

#### `c.var.tools.extend(localTools)`

Extend tools within a route handler for single-route tools that don't need
middleware. Returns a tools object with both parent and local tools.

> **Note:** The `ClientTools` instance must still be declared at module level,
> outside the route handler. Only the `extend()` call happens inside the
> handler.

```ts
// ✅ Declare at module level - registered once at startup
const singleRouteTools = new ClientTools(import.meta.url, {
  functions: {
    specialHandler() {
      console.log("special");
    },
  },
});

app.get("/special", (c) => {
  // Use extend inside the handler to access the tools
  const { fn, styled } = c.var.tools.extend(
    singleRouteTools,
  );

  return c.render(
    <button onClick={fn.specialHandler}>Special</button>,
  );
});
```

#### `getTools()`

Access tools from within async components (outside of route handlers). This uses
Hono's context storage to retrieve the current request's tools.

> **Note:** The `ClientTools` instance must still be declared at module level.
> `getTools()` is for accessing tools inside components, not for declaring them.

```tsx
import { ClientTools, css, getTools } from "@tiny-tools/hono";

const buttonStyle = css`
  background: blue;
`;

// ✅ Declare at module level
const componentTools = new ClientTools(import.meta.url, {
  functions: {
    buttonClick() {
      console.log("clicked");
    },
  },
  styles: { buttonStyle },
});

// Component that uses tools
function MyButton({ label }: { label: string }) {
  // Access tools from context - works in async components
  const { fn, styled } = getTools().extend(
    componentTools,
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
    componentTools,
  );

  return <div onClick={fn.globalHandler}>Uses global handler</div>;
}
```

### Build Module (`@tiny-tools/hono/build`)

#### `buildScriptFiles(options?)`

Builds all registered client functions and scoped styles to the public
directory.

```ts
import { buildScriptFiles } from "@tiny-tools/hono/build";

await buildScriptFiles({
  clientDir: "./client", // Source directory for client scripts
  publicDir: "./public", // Output directory
  handlerDir: "./public/handlers",
  stylesDir: "./public/styles",
});
```

### Components Module (`@tiny-tools/hono/components`)

#### `Suspense`

Streaming content with fallback support.

```tsx
import { Suspense } from "@tiny-tools/hono/components";

<Suspense fallback={<Loading />}>
  <AsyncContent />
</Suspense>;
```

#### `Partial`

Declarative partial page updates.

```tsx
import { Partial } from "@tiny-tools/hono/components";

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

### Client Module (`@tiny-tools/hono/client`)

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

// ❌ Error - functions from tools are not activated until used via middleware
const tools = new ClientTools(import.meta.url, {
  functions: { fn() {} },
});
<button onClick={tools.fn}>Click</button>; // Type error!
```

## License

MIT
