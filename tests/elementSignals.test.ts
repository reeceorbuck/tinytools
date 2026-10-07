import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { signalClasses } from "../signals.ts";
import { Signals } from "../clientTools.ts";

Deno.test("signals carry element references between handlers", () => {
  const { document } = parseHTML(
    `<html><body><div id="a"></div><div id="b"></div></body></html>`,
  );
  const a = document.getElementById("a")!;
  const b = document.getElementById("b")!;
  const { Signal, Computed } = signalClasses(true);

  const target = new Signal<Element | null>();
  const targetId = new Computed(() => target.value?.id ?? "none");
  let notifications = 0;
  const listener = new EventTarget();
  listener.addEventListener("signal", () => notifications++);
  target.subscribe(listener);

  assertEquals(targetId.value, "none");
  target.value = a;
  assertEquals([targetId.value, notifications], ["a", 1]);
  // The same element again is an equal value and does not notify.
  target.value = a;
  assertEquals(notifications, 1);
  target.value = b;
  assertEquals([targetId.value, notifications], ["b", 2]);

  const roots = new Signal<readonly Element[]>([]);
  const count = new Computed(() => roots.value.length);
  roots.value = [a, b];
  assertEquals(count.value, 2);
  // Arrays compare by item, so the same elements again do not notify.
  let rootNotifications = 0;
  const rootListener = new EventTarget();
  rootListener.addEventListener("signal", () => rootNotifications++);
  roots.subscribe(rootListener);
  roots.value = [a, b];
  assertEquals(rootNotifications, 0);
  roots.value = [b, a];
  assertEquals(rootNotifications, 1);
});

Deno.test("an element signal evaluates to null on the server", () => {
  const signals = new Signals(import.meta.url, ({ Signal, Computed }) => {
    const target = new Signal<Element | null>();
    const hasTarget = new Computed(() => target.value !== null);
    return { target, hasTarget };
  });
  assertEquals(signals.evaluateUsingInitialValues(), {
    target: null,
    hasTarget: false,
  });
});
