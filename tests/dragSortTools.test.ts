import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { dragSortTools, type SortedDetail } from "../handlers/dragSortTools.ts";
import { groupedDragSortTools } from "../handlers/groupedDragSortTools.ts";

const HEIGHT = 50;
const HEADING = 20;
const GAP = 10;
const WIDTH = 300;

/**
 * Installs a linkedom list with a stubbed layout. Each label is an item
 * HEIGHT px tall, or a HEADING px separator when it starts with "#"; they
 * are laid out in DOM order with GAP px between, hidden ones take no space,
 * and getBoundingClientRect adds an element's translateY.
 */
function install(labels: string[]) {
  const window = parseHTML(
    `<html><body><ol>${
      labels.map((label) =>
        label.startsWith("#")
          ? `<h3>${label}</h3>`
          : `<li draggable="true">${label}</li>`
      ).join("")
    }</ol></body></html>`,
  );
  const { document } = window;
  const list = document.querySelector("ol") as unknown as HTMLElement;
  const height = (el: HTMLElement): number =>
    el.hasAttribute("hidden")
      ? 0
      : el.tagName === "OL"
      ? Array.from(el.children).reduce(
        (sum, child) => sum + height(child as HTMLElement) + GAP,
        0,
      )
      : el.tagName === "H3"
      ? HEADING
      : HEIGHT;
  const top = (el: HTMLElement): number => {
    if (el.tagName === "OL" || el.hasAttribute("data-drag-preview")) return 0;
    let offset = 0;
    for (const sibling of Array.from(el.parentElement!.children)) {
      if (sibling === el) return offset;
      const size = height(sibling as HTMLElement);
      if (size > 0) offset += size + GAP;
    }
    return offset;
  };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetTop: {
      get() {
        return top(this);
      },
      configurable: true,
    },
    offsetHeight: {
      get() {
        return height(this);
      },
      configurable: true,
    },
    offsetWidth: { get: () => WIDTH, configurable: true },
    getBoundingClientRect: {
      value: function (this: HTMLElement) {
        const shift = Number(
          /translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1] ?? 0,
        );
        const y = top(this) + shift;
        return {
          left: 0,
          right: WIDTH,
          width: WIDTH,
          top: y,
          bottom: y + height(this),
        };
      },
      configurable: true,
    },
  });
  const ran: Event[] = [];
  Object.assign(globalThis, {
    document,
    CustomEvent: window.CustomEvent,
    getComputedStyle: () => ({ rowGap: `${GAP}px` }),
    requestAnimationFrame: (callback: () => void) => callback(),
    tiny: {
      runHandler: (_target: HTMLElement, event: Event) => ran.push(event),
    },
  });
  const children = () => Array.from(list.children) as unknown as HTMLElement[];
  const items = () => children().filter((child) => child.tagName === "LI");
  const order = () => children().map((child) => child.textContent);
  const preview = () =>
    document.querySelector("[data-drag-preview]") as unknown as
      | HTMLElement
      | null;
  /** A dragover anywhere on the page, seen by the drag's document listener. */
  const dragOver = (clientX: number, clientY: number) => {
    const event = new window.Event("dragover", { cancelable: true });
    Object.assign(event, { clientX, clientY, dataTransfer: {} });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { list, children, items, order, preview, dragOver, ran };
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
function dragEvent(target: HTMLElement, clientY: number, clientX = 100) {
  return {
    target,
    clientX,
    clientY,
    dataTransfer: {
      effectAllowed: "",
      dropEffect: "",
      setData() {},
      setDragImage() {},
    },
    preventDefault() {},
  } as unknown as DragEvent;
}

const run = dragSortTools.run;
await groupedDragSortTools.ensureDefined();
const grouped = groupedDragSortTools.run;

Deno.test("layoutDragSort shifts a neighbour once the dragged item is 60% over it", () => {
  const { list, items } = install(["a", "b", "c"]);
  try {
    const [a, b] = items();
    // a's bottom edge is 10px of gap plus a fraction of b's height past its own.
    const over = (fraction: number) => GAP + HEIGHT * fraction;
    assertEquals(run.layoutDragSort(list, a, over(0.55)), undefined);
    assertEquals(b.style.transform, "");
    assertEquals(run.layoutDragSort(list, a, over(0.65)), items()[2]);
    assertEquals(b.style.transform, `translateY(${-(HEIGHT + GAP)}px)`);
    // Clamped to the list: a can travel at most two slots.
    assertEquals(run.layoutDragSort(list, a, 1000), null);
    assertEquals(a.style.transform, `translateY(${2 * (HEIGHT + GAP)}px)`);
    // Moving back up releases the neighbours.
    run.layoutDragSort(list, a, 0);
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
    assertEquals(run.layoutDragSort(list, c, -(GAP + HEIGHT * 0.3)), b);
    assertEquals(b.style.transform, `translateY(${HEIGHT + GAP}px)`);
  } finally {
    uninstall();
  }
});

Deno.test("separators move aside, and the leading one stays above the items", () => {
  const { list, children } = install(["#one", "a", "b", "#two", "c"]);
  try {
    const [first, a, b, second, c] = children();
    const all = children();
    const layout = (item: HTMLElement, dy: number) =>
      run.layoutDragSort(list, item, dy, all);
    // Down past b and the second heading: c's group, before c.
    assertEquals(layout(a, 2 * (HEIGHT + GAP) + 5), c);
    assertEquals(second.style.transform, `translateY(${-(HEIGHT + GAP)}px)`);
    assertEquals(b.style.transform, `translateY(${-(HEIGHT + GAP)}px)`);
    // Only past the second heading going up: the end of the first group.
    layout(a, 0);
    assertEquals(layout(c, -(HEADING + GAP)), second);
    // Clamped below the leading heading, however far up.
    assertEquals(layout(c, -1000), a);
    assertEquals(first.style.transform, "");
    assertEquals(c.getBoundingClientRect().top, a.offsetTop);
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
    run.startDragSort.call(list, dragEvent(b, 100));
    assertEquals(b.dataset.dragging, "");
    let prevented = false;
    run.moveDragSort.call(list, {
      ...dragEvent(b, 100 + 2 * (HEIGHT + GAP)),
      preventDefault: () => prevented = true,
    } as unknown as DragEvent);
    assertEquals(prevented, true);
    run.dropDragSort.call(list, dragEvent(b, 100 + 2 * (HEIGHT + GAP)));
    run.endDragSort.call(list, dragEvent(b, 0));
    assertEquals(order(), ["a", "c", "d", "b"]);
    assertEquals(items().map((item) => item.style.transform), ["", "", "", ""]);
    assertEquals(b.hasAttribute("data-dragging"), false);
    assertEquals(dispatched.map(({ from, to }) => [from, to]), [[1, 3]]);
    assertEquals(ran.map((event) => event.type), ["sorted"]);
  } finally {
    uninstall();
  }
});

Deno.test("a drag that ends before the next frame leaves no item marked", () => {
  const { list, items } = install(["a", "b"]);
  const frames: Array<() => void> = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  try {
    const a = items()[0];
    run.startDragSort.call(list, dragEvent(a, 10));
    run.endDragSort.call(list, dragEvent(a, 10));
    for (const frame of frames) frame();
    assertEquals(a.hasAttribute("data-dragging"), false);
  } finally {
    uninstall();
  }
});

Deno.test("dragover without a drag of this list's items is not accepted", () => {
  const { list, items } = install(["a", "b"]);
  try {
    let prevented = false;
    run.moveDragSort.call(list, {
      ...dragEvent(items()[0], 40),
      preventDefault: () => prevented = true,
    } as unknown as DragEvent);
    assertEquals(prevented, false);
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
      run.sortByKey.call(list, {
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

Deno.test("a grouped drop lands in the group under the nearest separator", () => {
  const { list, children, order, dragOver, preview } = install([
    "#one",
    "a",
    "#two",
    "b",
  ]);
  const dispatched: SortedDetail[] = [];
  list.addEventListener(
    "sorted",
    (event) => dispatched.push((event as CustomEvent<SortedDetail>).detail),
  );
  try {
    const a = children()[1];
    const startY = a.offsetTop + 10;
    grouped.startGroupedDragSort.call(list, dragEvent(a, startY));
    // Past the second heading only: the top of its group.
    const y = startY + HEADING + GAP;
    assertEquals(dragOver(100, y), true);
    assertEquals(preview()!.style.display, "none");
    grouped.dropGroupedDragSort.call(list, dragEvent(a, y));
    grouped.endGroupedDragSort.call(list, dragEvent(a, 0));
    assertEquals(order(), ["#one", "#two", "a", "b"]);
    assertEquals(preview(), null);
    assertEquals(dispatched.map(({ from, to }) => [from, to]), [[0, 0]]);
  } finally {
    uninstall();
  }
});

Deno.test("leaving the list springs the item back and shows the preview at the cursor", () => {
  const { list, items, order, dragOver, preview, ran } = install([
    "a",
    "b",
    "c",
  ]);
  try {
    const a = items()[0];
    grouped.startGroupedDragSort.call(list, dragEvent(a, 20, 30));
    dragOver(30, 20 + HEIGHT + GAP);
    assertEquals(items()[1].style.transform !== "", true);
    // Off to the side: not accepted here, so other targets can take it.
    assertEquals(dragOver(WIDTH + 50, 90), false);
    assertEquals(a.dataset.dragOutside, "");
    assertEquals(items().map((item) => item.style.transform), ["", "", ""]);
    const shown = preview()!;
    assertEquals(shown.style.display, "");
    assertEquals(shown.hasAttribute("draggable"), false);
    // Held where it was grabbed: 30px in, 20px down.
    assertEquals([shown.style.left, shown.style.top], [
      `${WIDTH + 20}px`,
      "70px",
    ]);
    // Back over the list it is the item that moves again.
    dragOver(30, 20 + HEIGHT + GAP);
    assertEquals(a.hasAttribute("data-drag-outside"), false);
    assertEquals(shown.style.display, "none");
    grouped.endGroupedDragSort.call(list, dragEvent(a, 0));
    assertEquals(order(), ["a", "b", "c"]);
    assertEquals(items().map((item) => item.style.transform), ["", "", ""]);
    assertEquals(preview(), null);
    // The drag's listener is gone with it.
    assertEquals(dragOver(30, 20 + HEIGHT + GAP), false);
    assertEquals(ran, []);
  } finally {
    uninstall();
  }
});

Deno.test("sortGroupedByKey steps across separators and stops at the leading one", () => {
  const { list, children, order } = install(["#one", "a", "#two", "b"]);
  const dispatched: SortedDetail[] = [];
  list.addEventListener(
    "sorted",
    (event) => dispatched.push((event as CustomEvent<SortedDetail>).detail),
  );
  try {
    const key = (target: HTMLElement, key: string, altKey = true) =>
      grouped.sortGroupedByKey.call(list, {
        target,
        key,
        altKey,
        preventDefault() {},
      } as unknown as KeyboardEvent);
    const [, a, , b] = children();
    // Up across a separator: the end of the group above.
    key(b, "ArrowUp");
    assertEquals(order(), ["#one", "a", "b", "#two"]);
    key(b, "ArrowDown");
    assertEquals(order(), ["#one", "a", "#two", "b"]);
    // Never above the leading separator; without Alt nothing moves.
    key(a, "ArrowUp");
    key(a, "ArrowDown", false);
    assertEquals(order(), ["#one", "a", "#two", "b"]);
    key(a, "ArrowDown");
    assertEquals(order(), ["#one", "#two", "a", "b"]);
    key(a, "ArrowDown");
    key(a, "ArrowDown");
    assertEquals(order(), ["#one", "#two", "b", "a"]);
    assertEquals(dispatched.map(({ from, to }) => [from, to]), [
      [1, 1],
      [1, 1],
      [0, 0],
      [0, 1],
    ]);
  } finally {
    uninstall();
  }
});
