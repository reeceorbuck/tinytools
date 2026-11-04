/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assertMatch, assertStringIncludes } from "@std/assert";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { imports, Styles } from "../clientTools.ts";
import { css } from "../scopedStyles.ts";
import { sendUpdateStream } from "../sendUpdates.tsx";
import { ToastSignalComponent } from "../components/library/mod.ts";

// A page that has not shown a toast yet has neither its element declared nor
// its handlers loaded, so the update's head must name both.
Deno.test("an update's head lists the lifecycle tags and bundles its content uses", async () => {
  const { component } = await imports(ToastSignalComponent);
  const toasts = component.instance();
  let data = "";
  await sendUpdateStream(
    <toasts.Toast variant="error">Emails are not sending</toasts.Toast>,
    [{
      writeSSE(payload: { data: string }) {
        data += payload.data;
        return Promise.resolve();
      },
    }],
  );
  assertStringIncludes(data, "Emails are not sending");
  assertMatch(data, /<tt-define tag="tiny-toast"><\/tt-define>/);
  assertMatch(
    data,
    /<link rel="modulepreload" href="\/handlers\/Toast_\w+\.js"/,
  );
});

// A save often pushes the change to other clients while its own request is
// still running. What the update uses must be listed in the update, or a page
// first shown this content gets it without its stylesheet.
const updateStyles = new Styles({
  card: css`
    color: green;
  `,
});

async function StyledCard() {
  const { styled } = await imports(updateStyles);
  return <div class={styled.card}>Pushed</div>;
}

Deno.test("an update sent during a request lists what its content uses", async () => {
  let data = "";
  const app = new Hono();
  app.use(contextStorage());
  app.post("/save", async (c) => {
    await sendUpdateStream(<StyledCard />, [{
      writeSSE(payload: { data: string }) {
        data += payload.data;
        return Promise.resolve();
      },
    }]);
    return c.text("saved");
  });

  await app.request("/save", { method: "POST" });

  assertStringIncludes(data, "Pushed");
  assertMatch(data, /<link rel="stylesheet" href="\/styles\/[^"]+\.css"/);
});
