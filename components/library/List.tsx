/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A list people add to, and optionally reorder (by dragging, or Alt + ↑ / ↓)
 * and dismiss items from.
 *
 * `List` is a plain container: the look and the reordering and dismissing
 * belong to its `ListItem`s (an `<ol>`'s `<li>`s) or `ListRow`s (a
 * `<tbody>`'s `<tr>`s). The list is an `<ol>`, a `<tbody>` or a `<div>` by
 * what it holds, or as `as` names.
 *
 * ```tsx
 * const { component } = await tiny.imports(ListSignalComponent);
 * const tasks = component.instance();
 *
 * <tasks.List label="Tasks">
 *   <ListItem dismissable>Order stock</ListItem>
 *   <ListItem label="Call back patients">
 *     <a href="/recalls" onMouseOver={fn.preview}>Call back patients</a>
 *   </ListItem>
 * </tasks.List>
 * <tasks.AddItem placeholder="New task" dismissable />
 * ```
 *
 * `template` is what each added item clones. A template of `ListRow`s makes
 * the list the body of a table the page writes, whose first rows the page
 * renders itself:
 *
 * ```tsx
 * const costTemplates = new tiny.Templates({
 *   cost: () => <ListRow dismissable><td><input name="cost" /></td></ListRow>,
 * });
 * const costs = component.instance();
 *
 * <table>
 *   <thead><tr><th>Cost</th><th></th></tr></thead>
 *   <costs.List reorderable={false} template={template.cost}>
 *     {template.cost()}
 *   </costs.List>
 * </table>
 * <costs.AddButton label="Add another cost">+</costs.AddButton>
 * ```
 *
 * A template of anything else (a stack of form rows, say) is held as it is,
 * in a `<div>` the page styles through `class`. `signal.add` adds an item
 * from a button of the page's own:
 *
 * ```tsx
 * const entries = component.instance();
 *
 * <entries.List class={styled.stack} template={template.entry}>
 *   {rows.map((row) => <Entry values={row} />)}
 * </entries.List>
 * <entries.AddButton>Add</entries.AddButton>
 * <button type="button" onClick={fn.signals.fire(entries.signal.add)}>…</button>
 * ```
 *
 * Items' colours come from custom properties a caller may set on the list or
 * any ancestor: `--list-surface`, `--list-border`, `--list-text`,
 * `--list-muted` and `--list-accent`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h, type JSX } from "../../jsx-runtime.ts";
import { createContext, useContext } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  type ExposedSignals,
  mergeClassNames,
  optimized,
  type SignalComponent,
  type Trigger,
} from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { intrinsicTagName, templateRootTags } from "../../componentScope.ts";
import type { SortedEvent } from "../../handlers/dragSortTools.ts";
import { dragSortTools } from "../../handlers/dragSortTools.ts";

const tiny = optimized(import.meta.url);

/** An item added but not yet listed; a blank label is one to fill in. */
type PendingItem = { label: string; dismissable: boolean };

/**
 * One list per instance. `pending` holds items added but not yet listed: the
 * add parts append to it and the list moves them into items, so they meet
 * only through the signal, wherever each sits on the page. Firing `add`
 * adds a blank item, as `AddButton` does.
 */
const listSignals = new tiny.Signals(({ Signal, Trigger }) => ({
  pending: new Signal<PendingItem[]>([]),
  add: new Trigger(),
}));

/** The signals a list exposes. */
type ListExposed = { add: Trigger };

const listStyles = new tiny.Styles({
  list: css`
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;

    &:focus-visible {
      outline: 2px solid var(--list-accent, oklch(50.8% 0.105 165.6));
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
    border: 1px solid var(--list-border, light-dark(oklch(87.2% 0.009 258.3),
      oklch(32.8% 0.007 258.3)));
    border-radius: 6px;
    background: var(--list-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
    color: var(--list-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032
      264.7)));
    transition: transform var(--list-shift-duration) ease,
      box-shadow var(--list-shift-duration) ease;

    &[draggable="true"] {
      cursor: grab;
      user-select: none;
    }
    &[draggable="true"]::before {
      content: "⠿";
      color: var(--list-muted, light-dark(oklch(44.6% 0.026 256.8), oklch(75.4%
        0.026 256.8)));
    }
    &:focus-visible {
      outline: 2px solid var(--list-accent, oklch(50.8% 0.105 165.6));
      outline-offset: 2px;
    }
    &[data-dragging] {
      z-index: 1;
      cursor: grabbing;
      box-shadow: 0 6px 16px oklch(21% 0.032 264.7 / 0.16),
        0 2px 4px oklch(21% 0.032 264.7 / 0.08);
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
    color: var(--list-muted, light-dark(oklch(44.6% 0.026 256.8), oklch(75.4% 0.026
      256.8)));
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      background: var(--list-border, light-dark(oklch(87.2% 0.009 258.3),
        oklch(32.8% 0.007 258.3)));
      color: var(--list-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032
        264.7)));
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
      border: 1px solid var(--list-border, light-dark(oklch(87.2% 0.009 258.3),
        oklch(32.8% 0.007 258.3)));
      border-radius: 6px;
      font: inherit;
    }
    input:focus-visible {
      outline: 2px solid var(--list-accent, oklch(50.8% 0.105 165.6));
      outline-offset: 1px;
    }
  `,
});

/** Bundles register their exports here as they evaluate. */
type RegisteredBundles = Record<string, Record<string, unknown>>;

/** A list root, holding the live region its handlers announce through. */
type ListElement = HTMLElement & { listAnnouncer?: HTMLOutputElement };

const listHandlers = new tiny.Handlers(async () => {
  const { signal } = await tiny.imports(listSignals);
  return {
    /**
     * Moves the pending items into the list. Bound to the list's `onConnect`
     * and `onSignal`, so it runs whenever an add part adds one, or `add`
     * fires; its first run also places the list's live region, after the
     * list (or, for a table body, after its table).
     */
    refreshList: async function (this: ListElement, event?: Event) {
      const add = signal.add.forInstance(this);
      if ((event as { signal?: unknown } | undefined)?.signal === add) {
        const pending = signal.pending.forInstance(this);
        pending.value = [...pending.value, { label: "", dismissable: false }];
        return;
      }
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
      // A list of items wraps what isn't one already; a `<div>` holds it as
      // it is.
      const itemized = this.tagName !== "DIV";
      const added: (HTMLElement | null)[] = [];
      for (const { label, dismissable } of entries) {
        const content = clone?.({ label }) ?? document.createTextNode(label);
        const root = content instanceof DocumentFragment
          ? content.firstElementChild
          : null;
        let item = root?.hasAttribute("data-list-item")
          ? root as HTMLElement
          : null;
        if (!item && !itemized) {
          const before = this.lastElementChild;
          this.append(content);
          const last = this.lastElementChild as HTMLElement | null;
          added.push(last === before ? null : last);
          continue;
        }
        if (!item) {
          item = document.createElement(rows ? "tr" : "li");
          item.setAttribute("data-list-item", "");
          if (rows) {
            item.append(content);
          } else {
            item.className = this.dataset.itemClass ?? "";
            const holder = document.createElement("div");
            holder.append(content);
            item.append(holder);
          }
        }
        if (label) item.dataset.label = label;
        else if (item.dataset.label === "") delete item.dataset.label;
        if (this.hasAttribute("data-reorderable")) {
          item.draggable = true;
          item.tabIndex = 0;
        }
        const existing = item.querySelector<HTMLElement>("[data-dismiss]");
        // A button naming the blank `$[label]` names no item instead.
        if (existing && !item.dataset.label) {
          existing.setAttribute("aria-label", "Dismiss");
        }
        if (dismissable && !existing) {
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
        if (item === root) this.append(content);
        else this.append(item);
        added.push(item);
      }

      const named = entries.map((entry) => entry.label).filter(Boolean);
      if (named.length) {
        this.listAnnouncer.value = named.length === 1
          ? `${named[0]} added.`
          : `${named.length} items added.`;
      }
      // A blank item is there to be filled in: focus its first control.
      const blank = added.filter((item, index) => item && !entries[index].label)
        .at(-1);
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

/** The tag a child renders as its root, as far as it can be told. */
function rootTag(child: unknown): string | undefined {
  const name = (child as { tag?: { name?: string } })?.tag?.name;
  // An instance's `Item` and `Row` parts, or the components themselves.
  if (name === "ListItem" || name === "Item") return "li";
  if (name === "ListRow" || name === "Row") return "tr";
  const tag = templateRootTags(child)?.[0] ?? intrinsicTagName(child);
  if (tag) return tag;
  // Precompiled markup and a template's clone are text.
  return typeof child === "string" || child instanceof String
    ? /^\s*<([a-zA-Z][\w-]*)/.exec(String(child))?.[1]
    : undefined;
}

/** The element a list renders as. */
type ListAs = "div" | "ol" | "ul" | "tbody";

/** What `List` takes besides its items. */
type ListProps = {
  /** Names the list to assistive technology. */
  label?: string;
  /**
   * The list's element. By default a `<tbody>` holding rows, an `<ol>`
   * holding items (or only those `AddItem` adds), and otherwise a `<div>`.
   */
  as?: ListAs;
  /**
   * Whether its items can be dragged (or moved with Alt + ↑ / ↓). Default
   * true; a `<div>` holds no items to move.
   */
  reorderable?: boolean;
  /**
   * A `tiny.Templates` entry: each added item is a clone of it, with
   * `$[label]` filled in by the text added. A clone that isn't a `ListItem`
   * or `ListRow` is held in one, except in a `<div>`.
   */
  template?: ListTemplate;
  /** The former name of `template`. @deprecated Use `template`. */
  newItem?: { readonly reference: string };
  /** A class for the list element. */
  class?: string;
  children?: unknown;
};

/** A `tiny.Templates` entry, as `template.name` gives it. */
type ListTemplate = {
  readonly reference: string;
  (params?: Record<string, string | undefined>): unknown;
};

/** What `ListItem` and `ListRow` take. */
export type ListItemProps = {
  /** Names the item; defaults to its children when they are text. */
  label?: string;
  /** Whether the item gets a × button removing it. */
  dismissable?: boolean;
  children?: unknown;
};

const labelOf = (props: ListItemProps) =>
  props.label ||
  (typeof props.children === "string" ? props.children.trim() : undefined);

/** The attributes an item renders with, in the list it sits in. */
function itemAttributes(props: ListItemProps, reorderable: boolean) {
  return {
    "data-list-item": "",
    "data-label": labelOf(props),
    ...(reorderable ? { draggable: "true", tabindex: "0" } : {}),
  };
}

/** An item's × button. */
function dismissButton(props: ListItemProps, className: string) {
  const name = labelOf(props);
  return (
    <button
      type="button"
      class={className}
      data-dismiss=""
      aria-label={name ? `Dismiss ${name}` : "Dismiss"}
      title="Dismiss"
    >
      ×
    </button>
  );
}

/**
 * One item of a `List`: an `<li>` with the list's look, and a × button
 * when `dismissable`. Write it inside a list (an `<ol>`), or as a template's
 * markup, which the list clones for each item added.
 */
export async function ListItem(
  props: ListItemProps,
): Promise<HtmlEscapedString> {
  // Read before any await, while the list's context is current.
  const { reorderable } = useContext(ListContext);
  const { styled } = await tiny.imports(listStyles);
  return (
    <li class={styled.listItem} {...itemAttributes(props, reorderable)}>
      <div>{props.children}</div>
      {props.dismissable ? dismissButton(props, styled.dismissButton) : null}
    </li>
  );
}

/**
 * One row of a `List` that is a table body: a `<tr>` of the cells it holds,
 * and a cell with a × button when `dismissable`. It carries no class, so
 * the page's table styles reach it.
 */
export async function ListRow(
  props: ListItemProps,
): Promise<HtmlEscapedString> {
  const { reorderable } = useContext(ListContext);
  const { styled } = await tiny.imports(listStyles);
  return (
    <tr {...itemAttributes(props, reorderable)}>
      {props.children}
      {props.dismissable
        ? <td>{dismissButton(props, styled.dismissButton)}</td>
        : null}
    </tr>
  );
}

/** What `AddItem` and `AddButton` take; `dismissable` is for what they add. */
type AddProps = { label?: string; dismissable?: boolean };

/** What `AddItem` takes. */
type AddItemProps = AddProps & { placeholder?: string };

/**
 * What `AddButton` takes. Other attributes pass through to the button, such
 * as a `class` or a `data-*` attribute.
 */
type AddButtonProps =
  & AddProps
  & Omit<
    JSX.IntrinsicElements["button"],
    "type" | "onClick" | "aria-label" | "title"
  >
  & { children?: unknown };

/**
 * `List` holds what is written inside it and the items the add parts add:
 * `ListItem`s, `ListRow`s, or a template's clones as they are. `AddItem` is
 * a form adding its text as an item, and `AddButton` a button adding a
 * blank one, focusing its first control. The list exposes `signal.add`,
 * which adds a blank one when fired. An item's children are the caller's
 * markup, so they carry the caller's own handlers. `Item` and `Row` are
 * `ListItem` and `ListRow`.
 *
 * `reorderable` is the list's, and reaches the items written inside it
 * through context, and those it adds as it adds them; `dismissable` is
 * each item's own.
 */
export const ListSignalComponent: SignalComponent<{
  signal: ExposedSignals<ListExposed>;
  List: (props: ListProps) => JSX.Element;
  Item: (props: ListItemProps) => Promise<HtmlEscapedString>;
  Row: (props: ListItemProps) => Promise<HtmlEscapedString>;
  AddItem: (props: AddItemProps) => JSX.Element;
  AddButton: (props: AddButtonProps) => JSX.Element;
}> = new tiny.SignalComponent(async () => {
  const { fn, signal, styled } = await tiny.imports(
    listSignals.withRoot(),
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
  return {
    signal: [signal.add],
    List: (props: ListProps) => {
      const template = props.template ?? props.newItem;
      // What it holds, written and cloned, decides its element.
      const tags = [
        ...[props.children].flat().map(rootTag),
        props.template ? rootTag(String(props.template({ label: "" }))) : "",
      ];
      const as: ListAs = props.as ??
        (tags.some((tag) => tag === "tr" || tag === "td" || tag === "th")
          ? "tbody"
          : tags.includes("li") || !props.template
          ? "ol"
          : "div");
      const reorderable = as !== "div" && (props.reorderable ?? true);
      const attributes = {
        "aria-label": props.label,
        tabindex: as === "div" ? undefined : "-1",
        "data-reorderable": reorderable ? "" : undefined,
        "data-new-item": template?.reference,
        "data-item-class": styled.listItem,
        "data-dismiss-class": styled.dismissButton,
        "data-announcer-class": styled.announcer,
        onConnect: [
          fn.signals.subscribe(signal.pending, signal.add),
          fn.refreshList,
        ],
        onSignal: fn.refreshList,
        onClick: as === "div" ? undefined : fn.dismissItem,
        ...(reorderable ? sorting : {}),
      };
      const items = (
        <ListProvider value={{ reorderable }}>{props.children}</ListProvider>
      );
      // A table body and a plain list are the page's to style.
      switch (as) {
        case "div":
          return <div class={props.class} {...attributes}>{items}</div>;
        case "tbody":
          return <tbody class={props.class} {...attributes}>{items}</tbody>;
        case "ul":
          return (
            <ul
              class={mergeClassNames(styled.list, props.class)}
              {...attributes}
            >
              {items}
            </ul>
          );
        default:
          return (
            <ol
              class={mergeClassNames(styled.list, props.class)}
              {...attributes}
            >
              {items}
            </ol>
          );
      }
    },
    Item: ListItem,
    Row: ListRow,
    AddItem: (props: AddItemProps) => (
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
    AddButton: (
      { label, dismissable, children, ...rest }: AddButtonProps,
    ) => (
      <button
        {...rest}
        type="button"
        aria-label={label}
        title={label}
        data-dismissable={dismissable ? "" : undefined}
        onClick={fn.addBlankItem}
      >
        {children ?? "+"}
      </button>
    ),
  };
});
