import { assertEquals } from "@std/assert";
import { urlStyleVariables } from "../urlStyleVariables.ts";

Deno.test("urlStyleVariables declares path segments and query params", () => {
  assertEquals(
    urlStyleVariables(
      "https://example.com/appointments/2026-10-02?operator=7&operator=8&empty=",
    ),
    "--path-0: appointments; --path-1: 2026-10-02; --param-operator: 7;",
  );
});

Deno.test("urlStyleVariables skips values and keys that could break out", () => {
  assertEquals(
    urlStyleVariables(
      "https://example.com/a;b/ok?x=red;color:blue&y=}&z=a/*b&bad%20key=1&q=John%20Smith",
    ),
    "--path-1: ok; --param-q: John Smith;",
  );
});
