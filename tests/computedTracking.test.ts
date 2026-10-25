import { assertEquals } from "@std/assert";
import { signalClasses } from "../signals.ts";
import { signalRuntimeSources } from "../signalModules.ts";

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

Deno.test("a computed steps from its previous value, from an initial value", () => {
  const { Signal, Trigger, Computed } = signalClasses(true);
  const press = new Trigger();
  let runs = 0;
  const steps = new Computed(
    (step) => {
      runs++;
      return step + 10;
    },
    [press],
    0,
  );
  // The initial value stands in for the first run.
  assertEquals([steps.value, runs], [0, 0]);
  press.fire();
  press.fire();
  assertEquals([steps.value, runs], [20, 2]);

  // Without one, the first run sees `undefined`.
  const count = new Signal(1);
  const seen: (number | undefined)[] = [];
  const total = new Computed((previous?: number) => {
    seen.push(previous);
    return (previous ?? 0) + count.value;
  });
  count.value = 2;
  assertEquals([total.value, seen], [3, [undefined, 1]]);
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

Deno.test("the signal runtime modules track in the browser build", async () => {
  const url = (file: string): string =>
    `data:text/javascript,${
      encodeURIComponent(
        signalRuntimeSources.get(file)!.replace(
          /"\.\/(tt-[\w-]+\.js)"/g,
          (_: string, imported: string) => JSON.stringify(url(imported)),
        ),
      )
    }`;
  const files = [...signalRuntimeSources.keys()];
  const { SignalInstance: Signal } = await import(
    url(files.find((file) => file.startsWith("tt-signal_"))!)
  );
  const { ComputedInstance: Computed } = await import(
    url(files.find((file) => file.startsWith("tt-computed_"))!)
  );
  const count = new Signal(1);
  const double = new Computed(() => count.value * 2);
  count.value = 4;
  assertEquals(double.value, 8);
});
