import { assertEquals, assertExists } from "@std/assert";
import { handlers } from "../clientFunctions.ts";
import { clientRouteTools } from "../handlers/clientRouteTools.ts";

void clientRouteTools;

async function buildHandler(name: string) {
  const entry = [...handlers.values()].find((handler) =>
    handler.fnName === name
  );
  assertExists(entry);
  return (await import(
    `data:text/javascript,${encodeURIComponent(await entry.buildCode())}`
  )).default;
}

const compile = await buildHandler("compileClientRoute") as (
  path: string,
  query: string | null,
) => ((url: URL) => Record<string, string | undefined> | null) | null;
const interpolate = await buildHandler("interpolateClientRouteValue") as (
  value: string,
  params: Record<string, string | undefined>,
) => string;

Deno.test("client route matchers support URLPattern captures and query conditions", () => {
  const cases: [string | null, string, boolean][] = [
    [null, "?anything=1", true],
    ["", "", true],
    ["", "?empty=", false],
    [" NoNe ", "", true],
    ["none", "?value=1", false],
    ["mode=edit", "?mode=edit&other=1", true],
    ["mode=edit", "?mode=view", false],
    ["mode!=edit", "", true],
    ["mode!=edit", "?mode=edit", false],
    ["mode=*", "?mode=", true],
    ["mode=*", "", false],
    ["mode=null", "", true],
    ["mode=undefined", "?mode=", false],
    ["mode=", "?mode=", true],
    ["mode=", "", false],
    ["mode=edit&tab=notes", "?mode=edit&tab=notes", true],
    ["mode=edit&tab=notes", "?mode=edit", false],
    ["mode=edit|tab=notes", "?tab=notes", true],
    ["mode=edit&tab=notes|preview=*", "?mode=edit", false],
    ["mode=edit&tab=notes|preview=*", "?preview=", true],
    ["mode=edit&tab=notes|preview=*", "?mode=edit&tab=notes", true],
    ["value=a=b", "?value=a%3Db", true],
    ["value=a%26b%7Cc", "?value=a%26b%7Cc", true],
    ["full+name=Ada+Lovelace", "?full%20name=Ada%20Lovelace", true],
    ["value=%2A", "?value=other", false],
    ["value=%2A", "?value=*", true],
    ["value=%6Eull", "?value=null", true],
    ["mode=edit", "?mode=edit&mode=view", true],
    ["mode=edit", "?mode=view&mode=edit", false],
  ];
  for (const [query, search, expected] of cases) {
    const match = compile("/patients/:id", query);
    assertExists(match);
    const result = match(new URL(`https://example.com/patients/42${search}`));
    assertEquals(result !== null, expected, `${query} against ${search}`);
    if (result) assertEquals(result.id, "42");
    assertEquals(match(new URL("https://example.com/other")), null);
  }
  const wildcard = compile("/patients/*", null);
  assertExists(wildcard);
  assertEquals(wildcard(new URL("https://example.com/patients/42/notes")), {
    "0": "42/notes",
  });
});

Deno.test("invalid client route rules are disabled", () => {
  assertEquals(compile("/patients/(", null), null);
  for (
    const query of ["mode", "mode=edit|", "=value", "mode=edit&&tab=notes"]
  ) {
    assertEquals(compile("/patients/:id", query), null, query);
  }
});

Deno.test("client route interpolation is literal, single-pass, and own-property only", () => {
  assertEquals(
    interpolate("$[id] $[id] $[missing] $[optional] $[toString]", {
      id: "42",
      optional: undefined,
    }),
    "42 42   ",
  );
  assertEquals(
    interpolate("$[value] / $[id]", { value: "$& $$ $' $` $[id]", id: "42" }),
    "$& $$ $' $` $[id] / 42",
  );
  assertEquals(interpolate("$[a.b]", { "a.b": "literal" }), "literal");
});
