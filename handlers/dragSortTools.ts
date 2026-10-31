import { Handlers } from "../clientTools.ts";

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };

/** Detail of the `sorted` event a sortable list dispatches after an item moves. */
export type SortedDetail = {
  /** The item that moved. */
  item: HTMLElement;
  /** Its index among the sortable items before the move. */
  from: number;
  /**
   * Its index after the move. Equal to `from` when the item only crossed a
   * separator, such as a group heading (see `groupedDragSortTools`).
   */
  to: number;
};

/** The `sorted` event, bound with `onSorted`. */
export type SortedEvent = CustomEvent<SortedDetail>;

/** The sortable items of `list`: its direct children with `draggable="true"`. */
function dragSortItems(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLElement>(':scope > [draggable="true"]'),
  );
}

/** The item of `list` being dragged, if a drag of one is in progress. */
function dragSortDragged(list: HTMLElement): HTMLElement | null {
  return list.querySelector<HTMLElement>(
    ':scope > [draggable="true"][data-dragging]',
  );
}

/**
 * Moves `dragged` `dy` px from its slot, clamped to the list, and shifts each
 * of `children` it has passed by one slot. A child makes way once the
 * dragged item's leading edge is `data-sort-threshold` (default 0.6) of the
 * way over it. `children` are the list's items, or with separators between
 * them every rendered child; children before the first item stay above it.
 * Returns the child the dragged item should be inserted before (null for the
 * end), or undefined when it has not left its slot. Positions come from
 * `offsetTop`, which ignores transforms, so the layout stays fixed for the
 * whole drag.
 */
function layoutDragSort(
  list: HTMLElement,
  dragged: HTMLElement,
  dy: number,
  children: HTMLElement[] = dragSortItems(list),
): HTMLElement | null | undefined {
  const firstItem = children.find((child) =>
    child.getAttribute("draggable") === "true"
  )!;
  const last = children[children.length - 1];
  const minDy = firstItem.offsetTop - dragged.offsetTop;
  const maxDy = last.offsetTop + last.offsetHeight - dragged.offsetHeight -
    dragged.offsetTop;
  const offset = Math.min(maxDy, Math.max(minDy, dy));
  dragged.style.transform = `translateY(${offset}px)`;

  const threshold = Number(list.dataset.sortThreshold ?? 0.6);
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const slot = dragged.offsetHeight + gap;
  const top = dragged.offsetTop + offset;
  const bottom = top + dragged.offsetHeight;
  const from = children.indexOf(dragged);
  let insertBefore: HTMLElement | null | undefined = undefined;
  for (const [index, child] of children.entries()) {
    if (child === dragged) continue;
    if (
      index > from && bottom > child.offsetTop + child.offsetHeight * threshold
    ) {
      child.style.transform = `translateY(${-slot}px)`;
      insertBefore = children[index + 1] ?? null;
    } else if (
      index < from &&
      top < child.offsetTop + child.offsetHeight * (1 - threshold)
    ) {
      child.style.transform = `translateY(${slot}px)`;
      insertBefore ??= child;
    } else {
      child.style.transform = "";
    }
  }
  return insertBefore;
}

/** Returns every child to its slot, animated by the children's own transitions. */
function resetDragSort(list: HTMLElement): void {
  for (const child of Array.from(list.children) as HTMLElement[]) {
    child.style.transform = "";
  }
}

/**
 * Commits the order and animates `dragged` from where it was let go into its
 * new slot. The other children are already drawn in their new slots, so
 * their transforms are cleared with transitions off.
 */
function settleDragSort(
  list: HTMLElement,
  dragged: HTMLElement,
  insertBefore: HTMLElement | null,
): void {
  const children = Array.from(list.children) as HTMLElement[];
  const releasedTop = dragged.getBoundingClientRect().top;
  for (const child of children) {
    child.style.transition = "none";
    child.style.transform = "";
  }
  list.insertBefore(dragged, insertBefore);
  const slotTop = dragged.getBoundingClientRect().top;
  dragged.style.transform = `translateY(${releasedTop - slotTop}px)`;
  dragged.offsetHeight; // Commit the start position before transitioning.
  for (const child of children) child.style.transition = "";
  delete dragged.dataset.dragging;
  dragged.style.transform = "";
}

/**
 * Dispatches a bubbling `sorted` event from `list` and runs its `onSorted`
 * handlers.
 */
function dispatchSorted(list: HTMLElement, detail: SortedDetail): void {
  const event = new CustomEvent<SortedDetail>("sorted", {
    bubbles: true,
    detail,
  });
  list.dispatchEvent(event);
  if (list.hasAttribute("tt-handler-sorted")) tiny.runHandler(list, event);
}

/**
 * Drag-and-drop reordering for a single-column list, built on the native
 * HTML5 drag events. Bind every handler to the list; its direct children with
 * `draggable="true"` are the sortable items:
 *
 * ```tsx
 * const { fn } = await tiny.imports(dragSortTools);
 * <ol
 *   onDragStart={fn.startDragSort}
 *   onDragOver={fn.moveDragSort}
 *   onDrop={fn.dropDragSort}
 *   onDragEnd={fn.endDragSort}
 *   onKeyDown={fn.sortByKey}
 *   onSorted={fn.myAnnounce}
 * >
 *   <li draggable="true" tabindex="0">…</li>
 * </ol>
 * ```
 *
 * The dragged item follows the cursor vertically (the native drag image is
 * hidden) and carries `data-dragging`; the items it passes are shifted with
 * `transform`. Style the motion in CSS: give the items a `transform`
 * transition for the shifts and settle, keep `[data-dragging]` from
 * transitioning `transform` so it tracks the cursor, and mark it with a
 * shadow. `data-sort-threshold` on the list sets how far (0–1) the dragged
 * item must cover a neighbour before it makes way; the default is 0.6.
 * After a move the list dispatches a bubbling `sorted` event
 * ({@link SortedEvent}).
 *
 * For lists with group headings, or items that can also be dropped on
 * targets outside the list, use `groupedDragSortTools`, which builds on
 * these.
 */
export const dragSortTools: Handlers<{
  dragSortItems: typeof dragSortItems;
  dragSortDragged: typeof dragSortDragged;
  layoutDragSort: typeof layoutDragSort;
  resetDragSort: typeof resetDragSort;
  settleDragSort: typeof settleDragSort;
  dispatchSorted: typeof dispatchSorted;
  startDragSort(this: HTMLElement, event: DragEvent): void;
  moveDragSort(this: HTMLElement, event: DragEvent): void;
  dropDragSort(this: HTMLElement, event: DragEvent): void;
  /**
   * Runs after drop. A drag that wasn't committed (Escape, or released
   * outside the list) animates back.
   */
  endDragSort(this: HTMLElement, _event: DragEvent): void;
  /**
   * Alt+ArrowUp / Alt+ArrowDown moves the focused item past its neighbour,
   * as a keyboard alternative to dragging.
   */
  sortByKey(this: HTMLElement, event: KeyboardEvent): void;
}> = new Handlers(import.meta.url, {
  dragSortItems,
  dragSortDragged,
  layoutDragSort,
  resetDragSort,
  settleDragSort,
  dispatchSorted,
  startDragSort: function (this: HTMLElement, event: DragEvent) {
    const item = (event.target as Element).closest<HTMLElement>(
      '[draggable="true"]',
    );
    if (!item || item.parentElement !== this || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move";
    // Firefox only starts a drag when data is set.
    event.dataTransfer.setData("text/plain", item.textContent?.trim() ?? "");
    // Hide the native drag image: the item itself follows the cursor, locked
    // to the vertical axis. The image is captured when dragstart returns.
    const ghost = document.createElement("span");
    ghost.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 0, 0);
    setTimeout(() => ghost.remove());
    const startY = String(event.clientY);
    this.dataset.dragSortFrom = String(dragSortItems(this).indexOf(item));
    this.dataset.dragSortStartY = startY;
    // Chrome cancels the drag if the source is restyled during dragstart.
    // A drag can also end before the next frame, so only mark the item if
    // this drag is still the one in progress.
    requestAnimationFrame(() => {
      if (
        this.dataset.dragSortStartY === startY && item.parentElement === this
      ) {
        item.dataset.dragging = "";
      }
    });
  },
  moveDragSort: function (this: HTMLElement, event: DragEvent) {
    const dragged = dragSortDragged(this);
    // Only accept drags of this list's own items.
    if (!dragged || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    layoutDragSort(
      this,
      dragged,
      event.clientY - Number(this.dataset.dragSortStartY),
    );
  },
  dropDragSort: function (this: HTMLElement, event: DragEvent) {
    const dragged = dragSortDragged(this);
    if (!dragged) return;
    event.preventDefault();
    const insertBefore = layoutDragSort(
      this,
      dragged,
      event.clientY - Number(this.dataset.dragSortStartY),
    );
    if (insertBefore === undefined) return; // Not moved: dragend springs it back.
    settleDragSort(this, dragged, insertBefore);
    dispatchSorted(this, {
      item: dragged,
      from: Number(this.dataset.dragSortFrom),
      to: dragSortItems(this).indexOf(dragged),
    });
  },
  endDragSort: function (this: HTMLElement, _event: DragEvent) {
    for (const item of dragSortItems(this)) delete item.dataset.dragging;
    resetDragSort(this);
    delete this.dataset.dragSortFrom;
    delete this.dataset.dragSortStartY;
  },
  sortByKey: function (this: HTMLElement, event: KeyboardEvent) {
    if (!event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const item = (event.target as Element).closest<HTMLElement>(
      '[draggable="true"]',
    );
    if (!item || item.parentElement !== this) return;
    const items = dragSortItems(this);
    const from = items.indexOf(item);
    const to = event.key === "ArrowUp" ? from - 1 : from + 1;
    if (to < 0 || to >= items.length) return;
    event.preventDefault();
    // Moving an element blurs whatever had focus inside it.
    const focused = document.activeElement as HTMLElement | null;
    if (to < from) items[to].before(item);
    else items[to].after(item);
    (focused && item.contains(focused) ? focused : item).focus();
    dispatchSorted(this, { item, from, to });
  },
});
