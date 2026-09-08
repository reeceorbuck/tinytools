import { Hono } from "hono";
import { NewPartial, tiny } from "../../honoFactory.tsx";
import { ClientRoutes } from "../../components/ClientRoutes.tsx";
import { navigationTools } from "../../handlers/navigationTools.ts";
import { partialInsertHandlers } from "../../handlers/partialInsertHandlers.ts";

const app = new Hono()
  .use(...tiny.middleware.core())
  .use(tiny.middleware.webComponents())
  .use(tiny.middleware.sharedImports(navigationTools, partialInsertHandlers))
  .use(tiny.middleware.layout(({ children }, context) => {
    const { fn } = context.var.tools;
    return (
      <body onLoad={fn.handleNavigate}>
        <nav>
          <a href="/nested">Nested trial</a>
          {" | "}
          <a href="/a">A</a>
          {" | "}
          <a href="/b">B</a>
        </nav>
        <div id="panel"></div>
        {children}
        <ClientRoutes>
          <client-route path="/:page(a|b)" fallback>
            <NewPartial id="panel" onLoad={fn.partialReplace}>
              <p>Loading...</p>
            </NewPartial>
          </client-route>
        </ClientRoutes>
      </body>
    );
  }));

app.get("/nested/:type?", (context) => {
  const { fn } = context.var.tools;
  const type = context.req.param("type") ?? "a";
  const source = context.req.header("source-url");
  const sourcePath = source ? new URL(source, context.req.url).pathname : "";
  const content = (
    <NewPartial id="inner-panel" cache onLoad={fn.partialReplace}>
      <h2>Inner {type}</h2>
      <input aria-label="Inner text" />
    </NewPartial>
  );
  if (/^\/nested(?:\/[ab])?$/.test(sourcePath)) return context.render(content);
  return context.render(
    <NewPartial id="panel" cache="/nested{/:type}?" onLoad={fn.partialReplace}>
      <h1>Nested cache</h1>
      <input aria-label="Outer text" />
      <nav>
        <a href="/nested">Inner A</a>
        {" | "}
        <a href="/nested/b">Inner B</a>
      </nav>
      <section id="inner-panel"></section>
      {content}
    </NewPartial>,
  );
});

app.get("/:page", (context) => {
  const { fn } = context.var.tools;
  return context.render(
    <NewPartial id="panel" cache onLoad={fn.partialReplace}>
      <h1>Cache {context.req.param("page")}</h1>
      <input aria-label="Text" />
      <textarea aria-label="Notes"></textarea>
      <input type="checkbox" aria-label="Selected" />
    </NewPartial>,
  );
});

const port = Number(
  Deno.args.find((argument) => argument.startsWith("--port="))?.slice(7),
) || 3049;
Deno.serve({ hostname: "127.0.0.1", port }, app.fetch);
