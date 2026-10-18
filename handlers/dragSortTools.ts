import { Handlers } from "../clientTools.ts";

declare const tiny: { runHandler(target: HTMLElement, event: Event): unknown };

/** Detail of the `sorted` event a sortable list dispatches after an item moves. */
export type SortedDetail = {
  /** The item that moved. */
  item: HTMLElement;
  /** Its index before the move. */
  from: number;
  /** Its index after the move. */
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
 * item it has passed by one slot. An item makes way once the dragged item's
 * leading edge is `data-sort-threshold` (default 0.6) of the way over it.
 * Returns the item the dragged one should be inserted before (null for the
 * end), or undefined when it has not left its slot. Positions come from
 * `offsetTop`, which ignores transforms, so the layout stays fixed for the
 * whole drag.
 */
function layoutDragSort(
  list: HTMLElement,
  dragged: HTMLElement,
  dy: number,
): HTMLElement | null | undefined {
  const items = dragSortItems(list);
  const first = items[0];
  const last = items[items.length - 1];
  const minDy = first.offsetTop - dragged.offsetTop;
  const maxDy = last.offsetTop + last.offsetHeight - dragged.offsetHeight -
    dragged.offsetTop;
  const offset = Math.min(maxDy, Math.max(minDy, dy));
  dragged.style.transform = `translateY(${offset}px)`;

  const threshold = Number(list.dataset.sortThreshold ?? 0.6);
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const slot = dragged.offsetHeight + gap;
  const top = dragged.offsetTop + offset;
  const bottom = top + dragged.offsetHeight;
  const from = items.indexOf(dragged);
  let insertBefore: HTMLElement | null | undefined = undefined;
  for (const [index, item] of items.entries()) {
    if (item === dragged) continue;
    if (
      index > from && bottom > item.offsetTop + item.offsetHeight * threshold
    ) {
      item.style.transform = `translateY(${-slot}px)`;
      insertBefore = items[index + 1] ?? null;
    } else if (
      index < from &&
      top < item.offsetTop + item.offsetHeight * (1 - threshold)
    ) {
      item.style.transform = `translateY(${slot}px)`;
      insertBefore ??= item;
    } else {
      item.style.transform = "";
    }
  }
  return insertBefore;
}

/**
 * Commits the order and animates `dragged` from where it was let go into its
 * new slot. The other items are already drawn in their new slots, so their
 * transforms are cleared with transitions off.
 */
function settleDragSort(
  list: HTMLElement,
  dragged: HTMLElement,
  insertBefore: HTMLElement | null,
): void {
  const items = dragSortItems(list);
  const releasedTop = dragged.getBoundingClientRect().top;
  for (const item of items) {
    item.style.transition = "none";
    item.style.transform = "";
  }
  // Keep the new position relative to the list's other children too.
  list.insertBefore(
    dragged,
    insertBefore ?? items[items.length - 1].nextSibling,
  );
  const slotTop = dragged.getBoundingClientRect().top;
  dragged.style.transform = `translateY(${releasedTop - slotTop}px)`;
  dragged.offsetHeight; // Commit the start position before transitioning.
  for (const item of items) item.style.transition = "";
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
 */
export const dragSortTools = new Handlers(import.meta.url, {
  dragSortItems,
  dragSortDragged,
  layoutDragSort,
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
    this.dataset.dragSortFrom = String(dragSortItems(this).indexOf(item));
    this.dataset.dragSortStartY = String(event.clientY);
    // Chrome cancels the drag if the source is restyled during dragstart.
    requestAnimationFrame(() => {
      item.dataset.dragging = "";
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
  /**
   * Runs after drop. A drag that wasn't committed (Escape, or released
   * outside the list) animates back.
   */
  endDragSort: function (this: HTMLElement, _event: DragEvent) {
    for (const item of dragSortItems(this)) {
      delete item.dataset.dragging;
      item.style.transform = "";
    }
    delete this.dataset.dragSortFrom;
    delete this.dataset.dragSortStartY;
  },
  /**
   * Alt+ArrowUp / Alt+ArrowDown moves the focused item, as a keyboard
   * alternative to dragging.
   */
  sortByKey: function (this: HTMLElement, event: KeyboardEvent) {
    if (!event.altKey) return;
    const item = (event.target as Element).closest<HTMLElement>(
      '[draggable="true"]',
    );
    if (!item || item.parentElement !== this) return;
    const items = dragSortItems(this);
    const from = items.indexOf(item);
    const to = event.key === "ArrowUp"
      ? from - 1
      : event.key === "ArrowDown"
      ? from + 1
      : from;
    if (to === from || to < 0 || to >= items.length) return;
    event.preventDefault();
    if (to < from) this.insertBefore(item, items[to]);
    else this.insertBefore(item, items[to].nextSibling);
    item.focus();
    dispatchSorted(this, { item, from, to });
  },
});
