import { Handlers, imports } from "../clientTools.ts";
import { dragSortTools } from "./dragSortTools.ts";

/** A list in the middle of a drag: what the drag set up, to undo on dragend. */
type GroupedDragSortList = HTMLElement & {
  dragSortAbort?: AbortController;
  dragSortPreview?: HTMLElement;
};

/**
 * Every rendered child of `list`: the items and the separators between
 * them, which move aside like items but cannot be picked up.
 */
function dragSortChildren(list: HTMLElement): HTMLElement[] {
  return (Array.from(list.children) as HTMLElement[]).filter((child) =>
    child.offsetHeight > 0
  );
}

/**
 * A copy of `item` that follows the cursor while the drag is outside the
 * list. It is added beside the list, so the styles that reach the list's
 * items reach it too, and carries `data-drag-preview` for styling. Ids,
 * names and handler bindings are stripped so it acts on nothing.
 */
function createDragSortPreview(item: HTMLElement): HTMLElement {
  const preview = item.cloneNode(true) as HTMLElement;
  for (const element of [preview, ...preview.querySelectorAll("*")]) {
    for (const { name } of Array.from(element.attributes)) {
      if (
        name === "id" || name === "name" || name === "draggable" ||
        name === "data-dragging" || name.startsWith("on") ||
        name.startsWith("tt-handler-")
      ) {
        element.removeAttribute(name);
      }
    }
  }
  preview.setAttribute("data-drag-preview", "");
  preview.setAttribute("aria-hidden", "true");
  preview.inert = true;
  const { width } = item.getBoundingClientRect();
  preview.style.cssText =
    `position:fixed;left:0;top:0;margin:0;box-sizing:border-box;width:${width}px;pointer-events:none;z-index:1000;display:none`;
  item.parentElement!.parentElement!.append(preview);
  return preview;
}

const groupedDragSortHelpers = new Handlers(import.meta.url, {
  dragSortChildren,
  createDragSortPreview,
});

/**
 * Drag-and-drop reordering for a list with separators between its items,
 * such as group headings, whose items can also be dragged out onto drop
 * targets elsewhere on the page. It builds on `dragSortTools`; bind these
 * to the list in its place (there is no `onDragOver`: the drag is followed
 * across the page while it lasts):
 *
 * ```tsx
 * const { fn } = await tiny.imports(groupedDragSortTools);
 * <ol
 *   onDragStart={fn.startGroupedDragSort}
 *   onDrop={fn.dropGroupedDragSort}
 *   onDragEnd={fn.endGroupedDragSort}
 *   onKeyDown={fn.sortGroupedByKey}
 *   onSorted={fn.saveOrder}
 * >
 *   <h3>Today</h3>
 *   <li draggable="true">…</li>
 * </ol>
 * ```
 *
 * The list's children without `draggable="true"` are separators: they move
 * aside for a dragged item like items do, and the item lands in the group
 * below the nearest one above it. Separators before the first item stay
 * above it. When the cursor leaves the list, the item springs back to its
 * slot and gets `data-drag-outside`, and a copy marked `data-drag-preview`
 * follows the cursor, so the item can be dropped on targets elsewhere: they
 * read the drag's data and call `preventDefault()` on `dragover` as usual.
 * Style `[data-dragging]:not([data-drag-outside])` as the lifted item, with
 * no `transform` transition, so the spring back still animates.
 */
export const groupedDragSortTools = new Handlers(
  import.meta.url,
  async () => {
    const { fn } = await imports(dragSortTools, groupedDragSortHelpers);
    return {
      startGroupedDragSort: function (this: HTMLElement, event: DragEvent) {
        const list = this as GroupedDragSortList;
        const item = (event.target as Element).closest<HTMLElement>(
          '[draggable="true"]',
        );
        if (!item || item.parentElement !== list) return;
        fn.startDragSort.call(list, event);
        const box = item.getBoundingClientRect();
        const grabX = event.clientX - box.left;
        const grabY = event.clientY - box.top;
        const startY = event.clientY;
        const preview = fn.createDragSortPreview(item);
        list.dragSortPreview = preview;
        let origin: { left: number; top: number } | undefined;

        // Follows the drag wherever it goes until dragend, which aborts this.
        const abort = new AbortController();
        list.dragSortAbort = abort;
        document.addEventListener("dragover", (over) => {
          // This drag's own item, once it has been marked as dragging.
          const dragged = item.hasAttribute("data-dragging") ? item : null;
          if (!dragged) return;
          const bounds = list.getBoundingClientRect();
          const inside = over.clientX >= bounds.left &&
            over.clientX <= bounds.right && over.clientY >= bounds.top &&
            over.clientY <= bounds.bottom;
          if (inside) {
            over.preventDefault();
            if (over.dataTransfer) over.dataTransfer.dropEffect = "move";
            delete dragged.dataset.dragOutside;
            preview.style.display = "none";
            fn.layoutDragSort(
              list,
              dragged,
              over.clientY - startY,
              fn.dragSortChildren(list),
            );
            return;
          }
          dragged.dataset.dragOutside = "";
          fn.resetDragSort(list);
          preview.style.display = "";
          // A transformed or contained ancestor moves the fixed position's
          // origin, so measure where 0,0 lands once.
          origin ??= preview.getBoundingClientRect();
          const x = Math.min(grabX, preview.offsetWidth - 8);
          const y = Math.min(grabY, preview.offsetHeight - 8);
          preview.style.left = `${over.clientX - x - origin.left}px`;
          preview.style.top = `${over.clientY - y - origin.top}px`;
        }, { signal: abort.signal });
      },
      dropGroupedDragSort: function (this: HTMLElement, event: DragEvent) {
        const dragged = fn.dragSortDragged(this);
        if (!dragged) return;
        event.preventDefault();
        const insertBefore = fn.layoutDragSort(
          this,
          dragged,
          event.clientY - Number(this.dataset.dragSortStartY),
          fn.dragSortChildren(this),
        );
        if (insertBefore === undefined) return; // Not moved: dragend springs it back.
        fn.settleDragSort(this, dragged, insertBefore);
        fn.dispatchSorted(this, {
          item: dragged,
          from: Number(this.dataset.dragSortFrom),
          to: fn.dragSortItems(this).indexOf(dragged),
        });
      },
      /**
       * Runs after any drop, here or on another target. A drag that wasn't
       * committed to this list animates back.
       */
      endGroupedDragSort: function (this: HTMLElement, event: DragEvent) {
        const list = this as GroupedDragSortList;
        list.dragSortAbort?.abort();
        list.dragSortPreview?.remove();
        delete list.dragSortAbort;
        delete list.dragSortPreview;
        for (const item of fn.dragSortItems(list)) {
          delete item.dataset.dragOutside;
        }
        fn.endDragSort.call(list, event);
      },
      /**
       * Alt+ArrowUp / Alt+ArrowDown moves the focused item one step, as a
       * keyboard alternative to dragging: past a neighbouring item, or
       * across a separator into the next or previous group. It never moves
       * above the separators before the first item.
       */
      sortGroupedByKey: function (this: HTMLElement, event: KeyboardEvent) {
        if (!event.altKey) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        const item = (event.target as Element).closest<HTMLElement>(
          '[draggable="true"]',
        );
        if (!item || item.parentElement !== this) return;
        const children = fn.dragSortChildren(this);
        const index = children.indexOf(item);
        const from = fn.dragSortItems(this).indexOf(item);
        // Moving an element blurs whatever had focus inside it.
        const focused = document.activeElement as HTMLElement | null;
        if (event.key === "ArrowUp") {
          // Nothing above but the separators that lead the list.
          const leading = !children.slice(0, index).some((child) =>
            child.getAttribute("draggable") === "true"
          );
          if (leading) return;
          children[index - 1].before(item);
        } else {
          const next = children[index + 1];
          if (!next) return;
          next.after(item);
        }
        event.preventDefault();
        (focused && item.contains(focused) ? focused : item).focus();
        fn.dispatchSorted(this, {
          item,
          from,
          to: fn.dragSortItems(this).indexOf(item),
        });
      },
    };
  },
);
