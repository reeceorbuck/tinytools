import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { dragSortTools, type SortedDetail } from "../handlers/dragSortTools.ts";

const HEIGHT = 50;
const GAP = 10;

/**
 * Installs a linkedom list of `labels` with a stubbed layout: every item is
 * HEIGHT px tall with GAP px between, laid out in DOM order, and
 * getBoundingClientRect adds the item's translateY.
 */
function install(labels: string[]) {
  const { document, CustomEvent } = parseHTML(
    `<html><body><ol>${
      labels.map((label) => `<li draggable="true">${label}</li>`).join("")
    }</ol></body></html>`,
  );
  const list = document.querySelector("ol") as unknown as HTMLElement;
  const proto = Object.getPrototypeOf(list.firstElementChild);
  const top = (el: HTMLElement) =>
    Array.from(el.parentElement!.children).indexOf(el) * (HEIGHT + GAP);
  Object.defineProperties(proto, {
    offsetTop: {
      get() {
        return top(this);
      },
      configurable: true,
    },
    offsetHeight: { get: () => HEIGHT, configurable: true },
    getBoundingClientRect: {
      value: function (this: HTMLElement) {
        const shift = Number(
          /translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0,
        );
        return { top: top(this) + shift };
      },
      configurable: true,
    },
  });
  const ran: Event[] = [];
  Object.assign(globalThis, {
    document,
    CustomEvent,
    getComputedStyle: () => ({ rowGap: `${GAP}px` }),
    requestAnimationFrame: (callback: () => void) => callback(),
    tiny: {
      runHandler: (_target: HTMLElement, event: Event) => ran.push(event),
    },
  });
  const items = () => Array.from(list.children) as unknown as HTMLElement[];
  const order = () => items().map((item) => item.textContent);
  return { list, items, order, ran };
}

function uninstall() {
  const globals = globalThis as Record<string, unknown>;
  for (
    const name of [
      "document",
      "CustomEvent",
      "getComputedStyle",
      "requestAnimationFrame",
      "tiny",
    ]
  ) {
    delete globals[name];
  }
}

/** A drag event with just the members the handlers read. */
function dragEvent(target: HTMLElement, clientY: number) {
  let prevented = false;
  const event = {
    target,
    clientY,
    dataTransfer: {
      effectAllowed: "",
      dropEffect: "",
      setData() {},
      setDragImage() {},
    },
    preventDefault: () => prevented = true,
  } as unknown as DragEvent;
  return { event, prevented: () => prevented };
}

Deno.test("layoutDragSort shifts a neighbour once the dragged item is 60% over it", () => {
  const { list, items } = install(["a", "b", "c"]);
  try {
    const [a, b] = items();
    // a's bottom edge is 10px of gap plus a fraction of b's height past its own.
    const over = (fraction: number) => GAP + HEIGHT * fraction;
    assertEquals(
      dragSortTools.run.layoutDragSort(list, a, over(0.55)),
      undefined,
    );
    assertEquals(b.style.transform, "");
    assertEquals(
      dragSortTools.run.layoutDragSort(list, a, over(0.65)),
      items()[2],
    );
    assertEquals(b.style.transform, `translateY(${-(HEIGHT + GAP)}px)`);
    // Clamped to the list: a can travel at most two slots.
    assertEquals(dragSortTools.run.layoutDragSort(list, a, 1000), null);
    assertEquals(a.style.transform, `translateY(${2 * (HEIGHT + GAP)}px)`);
    // Moving back up releases the neighbours.
    dragSortTools.run.layoutDragSort(list, a, 0);
    assertEquals(items().map((item) => item.style.transform), [
      "translateY(0px)",
      "",
      "",
    ]);
  } finally {
    uninstall();
  }
});

Deno.test("layoutDragSort honours data-sort-threshold when dragging up", () => {
  const { list, items } = install(["a", "b", "c"]);
  try {
    list.dataset.sortThreshold = "0.25";
    const [, b, c] = items();
    // c's top edge 30% of the way up over b.
    assertEquals(
      dragSortTools.run.layoutDragSort(list, c, -(GAP + HEIGHT * 0.3)),
      b,
    );
    assertEquals(b.style.transform, `translateY(${HEIGHT + GAP}px)`);
  } finally {
    uninstall();
  }
});

Deno.test("a drop commits the order and reports it with a sorted event", () => {
  const { list, items, order, ran } = install(["a", "b", "c", "d"]);
  list.setAttribute("tt-handler-sorted", "x.y");
  const dispatched: SortedDetail[] = [];
  list.addEventListener(
    "sorted",
    (event) => dispatched.push((event as CustomEvent<SortedDetail>).detail),
  );
  try {
    const b = items()[1];
    dragSortTools.run.startDragSort.call(list, dragEvent(b, 100).event);
    assertEquals(b.hasAttribute("data-dragging"), true);
    const over = dragEvent(b, 100 + 2 * (HEIGHT + GAP));
    dragSortTools.run.moveDragSort.call(list, over.event);
    assertEquals(over.prevented(), true);
    dragSortTools.run.dropDragSort.call(
      list,
      dragEvent(b, 100 + 2 * (HEIGHT + GAP)).event,
    );
    dragSortTools.run.endDragSort.call(list, dragEvent(b, 0).event);
    assertEquals(order(), ["a", "c", "d", "b"]);
    assertEquals(items().map((item) => item.style.transform), ["", "", "", ""]);
    assertEquals(b.hasAttribute("data-dragging"), false);
    assertEquals(dispatched.map(({ from, to }) => [from, to]), [[1, 3]]);
    assertEquals(ran.map((event) => event.type), ["sorted"]);
  } finally {
    uninstall();
  }
});

Deno.test("a cancelled drag leaves the order and clears the shifts", () => {
  const { list, items, order, ran } = install(["a", "b", "c"]);
  try {
    const a = items()[0];
    dragSortTools.run.startDragSort.call(list, dragEvent(a, 0).event);
    dragSortTools.run.moveDragSort.call(list, dragEvent(a, HEIGHT + GAP).event);
    assertEquals(items()[1].style.transform !== "", true);
    dragSortTools.run.endDragSort.call(list, dragEvent(a, 0).event);
    assertEquals(order(), ["a", "b", "c"]);
    assertEquals(items().map((item) => item.style.transform), ["", "", ""]);
    assertEquals(ran, []);
  } finally {
    uninstall();
  }
});

Deno.test("dragover from outside the list is not accepted", () => {
  const { list, items } = install(["a", "b"]);
  try {
    const over = dragEvent(items()[0], 40);
    dragSortTools.run.moveDragSort.call(list, over.event);
    assertEquals(over.prevented(), false);
  } finally {
    uninstall();
  }
});

Deno.test("sortByKey moves the focused item with Alt+Arrow keys within bounds", () => {
  const { list, items, order } = install(["a", "b", "c"]);
  const dispatched: SortedDetail[] = [];
  list.addEventListener(
    "sorted",
    (event) => dispatched.push((event as CustomEvent<SortedDetail>).detail),
  );
  try {
    const key = (target: HTMLElement, key: string, altKey = true) =>
      dragSortTools.run.sortByKey.call(list, {
        target,
        key,
        altKey,
        preventDefault() {},
      } as unknown as KeyboardEvent);
    const a = items()[0];
    key(a, "ArrowUp");
    key(a, "ArrowDown", false);
    assertEquals(order(), ["a", "b", "c"]);
    key(a, "ArrowDown");
    assertEquals(order(), ["b", "a", "c"]);
    key(a, "ArrowDown");
    key(a, "ArrowDown");
    assertEquals(order(), ["b", "c", "a"]);
    assertEquals(dispatched.map(({ from, to }) => [from, to]), [[0, 1], [
      1,
      2,
    ]]);
  } finally {
    uninstall();
  }
});
