import { assertEquals } from "@std/assert";
import { interpolateLocalRouteValue } from "./localRoutes.ts";

Deno.test("local routes interpolate supplied and repeated parameters", () => {
  assertEquals(
    interpolateLocalRouteValue(
      "chart-$[date]-$[noteEntryId]-$[date]",
      { date: "2026-08-06", noteEntryId: "42" },
    ),
    "chart-2026-08-06-42-2026-08-06",
  );
});

Deno.test("local routes clear parameters omitted from the request", () => {
  assertEquals(
    interpolateLocalRouteValue("$[surfaces]", {}),
    "",
  );
  assertEquals(
    interpolateLocalRouteValue(
      "prefix-$[present]-$[optional]",
      { present: "value" },
    ),
    "prefix-value-",
  );
});
