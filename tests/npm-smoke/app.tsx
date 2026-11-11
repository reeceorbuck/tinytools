// A small app on the npm build, the way a Node or Bun user writes one.
import { Hono } from "hono";
import { css, optimized } from "@tinyenterprise/hono-tools";
import { DialogSignalComponent } from "@tinyenterprise/hono-tools/library";
import {
  applyNavigationHandlers,
  navigationTools,
  processIncomingDataTools,
} from "@tinyenterprise/hono-tools/handlers";

const tiny = optimized(import.meta.url);

const buttonHandlers = new tiny.Handlers({
  greet(this: HTMLButtonElement) {
    this.textContent = "Hello!";
  },
});

const buttonStyles = new tiny.Styles({
  button: css`
    padding: 8px 16px;
    background: royalblue;
  `,
});

const counter = new tiny.Signals({ count: 0 });

export const app = new Hono().use(...tiny.middleware.core());

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

app.get("/", async (c) => {
  const { fn, styled } = await tiny.imports(buttonHandlers, buttonStyles);
  return c.render(
    <button type="button" class={styled.button} onClick={fn.greet}>
      Say hello
    </button>,
  );
});

app.get("/counter", async (c) => {
  const { fn, signal } = await tiny.imports(counter);
  return c.render(
    <>
      <button type="button" value={1} onClick={fn.signals.add(signal.count)}>
        Add one
      </button>
      <p>Clicked {signal.count} times.</p>
    </>,
  );
});

app.get("/profile", async (c) => {
  const { component } = await tiny.imports(DialogSignalComponent);
  const dialog = component.instance();
  return c.render(
    <>
      <dialog.Open>Edit profile</dialog.Open>
      <dialog.Panel label="Edit profile">
        <form method="post">
          <input name="name" />
          <button type="submit">Save</button>
        </form>
        <dialog.Close>Cancel</dialog.Close>
      </dialog.Panel>
    </>,
  );
});
