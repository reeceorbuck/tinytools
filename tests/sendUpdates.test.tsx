/** @jsxRuntime automatic */
/** @jsxImportSource @tinytools/hono-tools */
import { assertMatch, assertStringIncludes } from "@std/assert";
import { imports } from "../clientTools.ts";
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
