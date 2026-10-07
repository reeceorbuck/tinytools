import { assertEquals } from "@std/assert";
import { signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

Deno.test("computed signals follow the signals they read", () => {
  const { Signal, Computed } = signalClasses(true);
  const mode = new Signal<"a" | "b">("a");
  const a = new Signal<number>(1);
  const b = new Signal<number>(10);
  let runs = 0;
  const picked = new Computed(() => {
    runs++;
    return mode.value === "a" ? a.value : b.value;
  });
  const label = new Computed(() => `picked ${picked.value}`);
  assertEquals([picked.value, label.value, runs], [1, "picked 1", 1]);

  a.value = 2;
  assertEquals([picked.value, label.value, runs], [2, "picked 2", 2]);
  // A signal read only in the branch not taken does not trigger a run.
  b.value = 20;
  assertEquals(runs, 2);

  mode.value = "b";
  assertEquals([picked.value, label.value, runs], [20, "picked 20", 3]);
  // Dependencies are re-tracked on every run.
  a.value = 3;
  assertEquals(runs, 3);
  b.value = 30;
  assertEquals([picked.value, label.value, runs], [30, "picked 30", 4]);

  // Explicit dependencies still work, and are not needed for tracked reads.
  const doubled = new Computed(() => a.value * 2, [a]);
  a.value = 4;
  assertEquals(doubled.value, 8);
});

Deno.test("array values compare by item and are read from control groups", () => {
  const { Signal } = signalClasses(true);
  const surfaces = new Signal<string[]>(["M"]);
  let notified = 0;
  const target = new EventTarget();
  target.addEventListener("signal", () => notified++);
  surfaces.subscribe(target);
  surfaces.value = ["M"];
  assertEquals(notified, 0);
  surfaces.value = ["M", "O"];
  assertEquals(notified, 1);

  surfaces.unsubscribe(target);
  surfaces.value = [];
  assertEquals(notified, 1);

  // A numeric signal reads numbers, a boolean signal a checkbox's state.
  type Handling = { handleEvent(target: unknown, event: Event): unknown };
  const depth = new Signal<number>(1);
  (depth as unknown as Handling).handleEvent(null, {
    type: "input",
    target: { value: "3", dataset: {} },
  } as unknown as Event);
  assertEquals(depth.value, 3);
  const flag = new Signal<boolean>(false);
  (flag as unknown as Handling).handleEvent(null, {
    type: "change",
    target: { type: "checkbox", checked: true, value: "on", dataset: {} },
  } as unknown as Event);
  assertEquals(flag.value, true);
});

Deno.test("the signal runtime bundles and tracks in the browser build", async () => {
  // The runtime bundle is registered the first time a collection needs it.
  void (Signals as unknown as { runtime: unknown }).runtime;
  const classes = await loadHandler<typeof signalClasses>("signalClasses");
  const { Signal, Computed } = classes(true);
  const count = new Signal<number>(1);
  const double = new Computed(() => count.value * 2);
  count.value = 4;
  assertEquals(double.value, 8);
});
