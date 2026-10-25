/**
 * A list people add to, and optionally reorder (by dragging, or Alt + ↑ / ↓)
 * and dismiss items from.
 *
 * ```tsx
 * const { component } = await tiny.imports(ListSignalComponent);
 * const tasks = component.instance();
 *
 * <tasks.List label="Tasks">
 *   <tasks.Item dismissable>Order stock</tasks.Item>
 *   <tasks.Item label="Call back patients">
 *     <a href="/recalls" onMouseOver={fn.preview}>Call back patients</a>
 *   </tasks.Item>
 * </tasks.List>
 * <tasks.AddItem placeholder="New task" dismissable />
 * ```
 *
 * A `List` of `Row`s is a table body, inside a table the page writes:
 *
 * ```tsx
 * const costs = component.instance();
 *
 * <table>
 *   <thead><tr><th>Item</th><th>Cost</th></tr></thead>
 *   <costs.List reorderable={false} newItem={template.costCells}>
 *     <costs.Row>{template.costCells()}</costs.Row>
 *   </costs.List>
 * </table>
 * <costs.AddButton label="Add another cost">+</costs.AddButton>
 * ```
 *
 * Items' colours come from custom properties a caller may set on the list or
 * any ancestor: `--list-surface`, `--list-border`, `--list-text`,
 * `--list-muted` and `--list-accent`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { createContext, useContext } from "hono/jsx";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { intrinsicTagName, templateRootTags } from "../../componentScope.ts";
import type { SortedEvent } from "../../handlers/dragSortTools.ts";
import { dragSortTools } from "../../handlers/dragSortTools.ts";

/** An item added but not yet listed; a blank label is one to fill in. */
type PendingItem = { label: string; dismissable: boolean };

/**
 * One list per instance. `pending` holds items added but not yet listed: the
 * add parts append to it and the list moves them into items, so they meet
 * only through the signal, wherever each sits on the page.
 */
const listSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({ pending: new Signal<PendingItem[]>([]) })),
);

const listStyles = new tiny.Styles(import.meta.url, {
  list: css`
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;

    &:focus-visible {
      outline: 2px solid var(--list-accent, #047857);
      outline-offset: 2px;
    }
  `,
  listItem: css`
    --list-shift-duration: 160ms;

    position: relative;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 2.75rem;
    padding: 0.5rem 0.5rem 0.5rem 0.75rem;
    border: 1px solid var(--list-border, #d1d5db);
    border-radius: 6px;
    background: var(--list-surface, #fff);
    color: var(--list-text, #111827);
    transition: transform var(--list-shift-duration) ease,
      box-shadow var(--list-shift-duration) ease;

    &[draggable="true"] {
      cursor: grab;
      user-select: none;
    }
    &[draggable="true"]::before {
      content: "⠿";
      color: var(--list-muted, #4b5563);
    }
    &:focus-visible {
      outline: 2px solid var(--list-accent, #047857);
      outline-offset: 2px;
    }
    &[data-dragging] {
      z-index: 1;
      cursor: grabbing;
      box-shadow: 0 6px 16px rgb(17 24 39 / 0.16),
        0 2px 4px rgb(17 24 39 / 0.08);
      /* Follows the cursor exactly; only the settle after release animates. */
      transition: box-shadow var(--list-shift-duration) ease;
    }
    > div {
      flex: 1;
    }
    @media (prefers-reduced-motion: reduce) {
      transition: box-shadow var(--list-shift-duration) ease;
    }
  `,
  dismissButton: css`
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--list-muted, #4b5563);
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      background: var(--list-border, #d1d5db);
      color: var(--list-text, #111827);
    }
  `,
  /** Announcements for screen readers only. */
  announcer: css`
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  `,
  addItem: css`
    display: flex;
    gap: 0.5rem;

    input {
      flex: 1;
      min-width: 0;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--list-border, #d1d5db);
      border-radius: 6px;
      font: inherit;
    }
    input:focus-visible {
      outline: 2px solid var(--list-accent, #047857);
      outline-offset: 1px;
    }
  `,
});

/** Bundles register their exports here as they evaluate. */
type RegisteredBundles = Record<string, Record<string, unknown>>;

/** A list root, holding the live region its handlers announce through. */
type ListElement = HTMLElement & { listAnnouncer?: HTMLOutputElement };

const listHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(listSignals);
  return {
    /**
     * Moves the pending items into the list. Bound to the list's `onConnect`
     * and `onSignal`, so it runs whenever an add part adds one; its first
     * run also places the list's live region, after the list (or, for a
     * table body, after its table).
     */
    refreshList: async function (this: ListElement) {
      if (!this.listAnnouncer) {
        const output = document.createElement("output");
        output.className = this.dataset.announcerClass ?? "";
        output.setAttribute("aria-live", "polite");
        (this.closest("table") ?? this).after(output);
        this.listAnnouncer = output;
      }
      const pending = signal.pending.forInstance(this);
      const entries = pending.value;
      if (!entries.length) return;
      pending.value = [];

      // Added items hold a clone of `newItem` when there is one.
      let clone: ((params: Record<string, string>) => Node) | undefined;
      const reference = this.dataset.newItem;
      if (reference) {
        const dot = reference.indexOf(".");
        const bundle = reference.slice(0, dot);
        // Held in a variable so `deno publish` leaves the URL alone.
        const url = `/handlers/${bundle}.js`;
        const module =
          (globalThis as { handlers?: RegisteredBundles }).handlers?.[
            bundle
          ] ?? await import(url);
        clone = module[reference.slice(dot + 1)] as typeof clone;
      }
      const rows = this instanceof HTMLTableSectionElement;
      const added: HTMLElement[] = [];
      for (const { label, dismissable } of entries) {
        const item = document.createElement(rows ? "tr" : "li");
        item.setAttribute("data-list-item", "");
        if (label) item.dataset.label = label;
        const content = clone?.({ label }) ?? document.createTextNode(label);
        if (rows) {
          item.append(content);
        } else {
          item.className = this.dataset.itemClass ?? "";
          const holder = document.createElement("div");
          holder.append(content);
          item.append(holder);
        }
        if (this.hasAttribute("data-reorderable")) {
          item.draggable = true;
          item.tabIndex = 0;
        }
        if (dismissable) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = this.dataset.dismissClass ?? "";
          button.setAttribute("data-dismiss", "");
          button.setAttribute(
            "aria-label",
            label ? `Dismiss ${label}` : "Dismiss",
          );
          button.title = "Dismiss";
          button.textContent = "×";
          if (rows) {
            const cell = document.createElement("td");
            cell.append(button);
            item.append(cell);
          } else {
            item.append(button);
          }
        }
        this.append(item);
        added.push(item);
      }

      const named = entries.map((entry) => entry.label).filter(Boolean);
      if (named.length) {
        this.listAnnouncer.value = named.length === 1
          ? `${named[0]} added.`
          : `${named.length} items added.`;
      }
      // A blank item is there to be filled in: focus its first control.
      const blank = added.filter((_, index) => !entries[index].label).at(-1);
      blank?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    },
    /**
     * Removes the item whose dismiss button was clicked, announcing it and
     * moving focus to the next item (or the previous one, or the list).
     */
    dismissItem: function (this: ListElement, event: MouseEvent) {
      const button = (event.target as Element).closest?.("[data-dismiss]");
      const item = button?.closest<HTMLElement>("[data-list-item]");
      if (!item || item.parentElement !== this) return;
      const next = (item.nextElementSibling ?? item.previousElementSibling) as
        | HTMLElement
        | null;
      const name = item.dataset.label ??
        item.querySelector(":scope > div")?.textContent?.trim();
      if (this.listAnnouncer && name) {
        this.listAnnouncer.value = `${name} dismissed.`;
      }
      item.remove();
      // Items take focus only when they can be reordered.
      (next && next.tabIndex < 0
        ? next.querySelector<HTMLElement>("[data-dismiss]")
        : next ?? this)?.focus();
    },
    /** Adds the input's text to the list of the form's instance. */
    addItem: function (this: HTMLFormElement, event: SubmitEvent) {
      event.preventDefault();
      const input = this.elements.namedItem("item") as HTMLInputElement;
      const label = input.value.trim();
      if (!label) return;
      const pending = signal.pending.forInstance(this);
      const dismissable = this.hasAttribute("data-dismissable");
      pending.value = [...pending.value, { label, dismissable }];
      this.reset();
      input.focus();
    },
    /** Adds a blank item to the list of the button's instance. */
    addBlankItem: function (this: HTMLButtonElement) {
      const pending = signal.pending.forInstance(this);
      const dismissable = this.hasAttribute("data-dismissable");
      pending.value = [...pending.value, { label: "", dismissable }];
    },
    /** Announces where a dragged or keyed item ended up. */
    announceSorted: function (this: ListElement, event: SortedEvent) {
      const { item, to } = event.detail;
      const count = this.querySelectorAll(':scope > [draggable="true"]')
        .length;
      const name = item.dataset.label ??
        item.querySelector(":scope > div")?.textContent?.trim() ?? "Item";
      if (this.listAnnouncer) {
        this.listAnnouncer.value = `${name} moved to position ${
          to + 1
        } of ${count}.`;
      }
    },
  };
});

/** What a `List` tells the items written inside it. */
const ListContext = createContext({ reorderable: false });
/** Typed for this package's JSX, which Hono's own component type is not. */
const ListProvider = ListContext.Provider as unknown as (
  props: { value: { reorderable: boolean }; children?: unknown },
) => h.JSX.Element;

/** Whether a child renders a table row: a `Row`, or a `<tr>` itself. */
function isRow(child: unknown): boolean {
  if ((child as { tag?: { name?: string } })?.tag?.name === "Row") return true;
  return (templateRootTags(child)?.[0] ?? intrinsicTagName(child)) === "tr";
}

/** What `List` takes besides its items. */
type ListProps = {
  /** Names the list to assistive technology. */
  label?: string;
  /** Whether items can be dragged (or moved with Alt + ↑ / ↓). Default true. */
  reorderable?: boolean;
  /**
   * A `tiny.Templates` entry: each added item holds a clone of it, with
   * `$[label]` filled in, instead of the label alone.
   */
  newItem?: { readonly reference: string };
  children?: unknown;
};

/** What `Item` and `Row` take. */
type ItemProps = {
  /** Names the item; defaults to its children when they are text. */
  label?: string;
  /** Whether the item gets a × button removing it. */
  dismissable?: boolean;
  children?: unknown;
};

/** What `AddItem` and `AddButton` take; `dismissable` is for what they add. */
type AddProps = { label?: string; dismissable?: boolean };

/**
 * `List` holds the items written inside it: an `<ol>` of `Item`s, or the
 * `<tbody>` of a table the page writes when they are `Row`s. `AddItem` is a
 * form adding its text as an item, and `AddButton` a button adding a blank
 * one, focusing its first control. None exposes signals. An item's children
 * are the caller's markup, so they carry the caller's own handlers.
 *
 * `reorderable` is the list's, and reaches its items through context;
 * `dismissable` is each item's own.
 */
export const ListSignalComponent = new tiny.SignalComponent(async () => {
  const { fn, signal, styled } = await tiny.imports(
    listSignals,
    listHandlers,
    listStyles,
    dragSortTools,
  );
  const sorting = {
    onDragStart: fn.startDragSort,
    onDragOver: fn.moveDragSort,
    onDrop: fn.dropDragSort,
    onDragEnd: fn.endDragSort,
    onKeyDown: fn.sortByKey,
    onSorted: fn.announceSorted,
  };
  const labelOf = (props: ItemProps) =>
    props.label ??
      (typeof props.children === "string" ? props.children.trim() : undefined);
  /** The attributes an item renders with, in the list it sits in. */
  const itemAttributes = (props: ItemProps) => {
    const { reorderable } = useContext(ListContext);
    return {
      "data-list-item": "",
      "data-label": labelOf(props),
      ...(reorderable ? { draggable: "true", tabindex: "0" } : {}),
    };
  };
  const dismissButton = (props: ItemProps) => {
    const name = labelOf(props);
    return (
      <button
        type="button"
        class={styled.dismissButton}
        data-dismiss=""
        aria-label={name ? `Dismiss ${name}` : "Dismiss"}
        title="Dismiss"
      >
        ×
      </button>
    );
  };
  return {
    List: (props: ListProps) => {
      const reorderable = props.reorderable ?? true;
      const rows = [props.children].flat().some(isRow);
      const attributes = {
        "aria-label": props.label,
        tabindex: "-1",
        "data-reorderable": reorderable ? "" : undefined,
        "data-new-item": props.newItem?.reference,
        "data-item-class": styled.listItem,
        "data-dismiss-class": styled.dismissButton,
        "data-announcer-class": styled.announcer,
        onConnect: [signal.pending, fn.refreshList],
        onSignal: fn.refreshList,
        onClick: fn.dismissItem,
        ...(reorderable ? sorting : {}),
      };
      const items = (
        <ListProvider value={{ reorderable }}>{props.children}</ListProvider>
      );
      // A table body is the page's to style, so it carries no class that
      // would stop the page's styles reaching its rows.
      return rows
        ? <tbody {...attributes}>{items}</tbody>
        : <ol class={styled.list} {...attributes}>{items}</ol>;
    },
    Item: (props: ItemProps) => (
      <li class={styled.listItem} {...itemAttributes(props)}>
        <div>{props.children}</div>
        {props.dismissable ? dismissButton(props) : null}
      </li>
    ),
    Row: (props: ItemProps) => (
      <tr {...itemAttributes(props)}>
        {props.children}
        {props.dismissable ? <td>{dismissButton(props)}</td> : null}
      </tr>
    ),
    AddItem: (props: AddProps & { placeholder?: string }) => (
      <form
        class={styled.addItem}
        data-dismissable={props.dismissable ? "" : undefined}
        onSubmit={fn.addItem}
      >
        <input
          type="text"
          name="item"
          aria-label={props.label ?? "New item"}
          placeholder={props.placeholder ?? "New item"}
          autocomplete="off"
          required
        />
        <button type="submit">Add</button>
      </form>
    ),
    AddButton: (props: AddProps & { children?: unknown }) => (
      <button
        type="button"
        aria-label={props.label}
        title={props.label}
        data-dismissable={props.dismissable ? "" : undefined}
        onClick={fn.addBlankItem}
      >
        {props.children ?? "+"}
      </button>
    ),
  };
});
