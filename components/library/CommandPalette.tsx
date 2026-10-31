/**
 * A command palette: a search box over the page's links and actions, opened
 * with Ctrl + K (⌘ K on a Mac) or a trigger, and driven from the keyboard.
 *
 * ```tsx
 * const { component } = await tiny.imports(CommandPaletteSignalComponent);
 * const commands = component.instance();
 *
 * <commands.Trigger />
 * <commands.Palette label="Go to">
 *   <commands.Group heading="Pages">
 *     <commands.Item href="/appointments" keywords="diary book">
 *       Appointments
 *     </commands.Item>
 *     <commands.Item href="/stock">Stock</commands.Item>
 *   </commands.Group>
 *   <commands.Group heading="Actions">
 *     <commands.Item onClick={fn.newPatient}>New patient</commands.Item>
 *   </commands.Group>
 * </commands.Palette>
 * ```
 *
 * Typing keeps the items holding every word typed, in their text or
 * `keywords`, ignoring case and accents; a group with none left hides. ↑ and
 * ↓ move between the items left, Enter chooses one and Escape closes. A
 * chosen item is clicked, so a link navigates as any link would (through
 * client routing too) and a button runs its own `onClick`; then the palette
 * closes.
 *
 * Only a palette on the page listens for its shortcut, and it stops when
 * the palette leaves. `shortcut` changes the key; `false` turns it off.
 *
 * Colours come from custom properties a caller may set on the palette or any
 * ancestor: `--palette-surface`, `--palette-border`, `--palette-text`,
 * `--palette-muted`, `--palette-active` and `--palette-backdrop`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { type HandlerProp, tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import type { SignalEvent } from "../../handlers/signals.ts";
import type { LifecycleElement } from "../../lifecycleElement.ts";

/** Whether the palette is open, one per instance. */
const paletteSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({ open: new Signal<boolean>(false) })),
);

/** Helpers the handlers share, called through `fn`. */
const paletteTools = new tiny.Handlers(import.meta.url, {
  /** The items the query leaves showing. */
  shownItems(palette: HTMLElement): HTMLElement[] {
    return [...palette.querySelectorAll<HTMLElement>("[data-command]")]
      .filter((item) => !item.hidden);
  },
  /** Marks `item` as the one Enter chooses, scrolling it into view. */
  activate(palette: HTMLElement, item: HTMLElement | undefined): void {
    const input = palette.querySelector("input")!;
    for (const other of palette.querySelectorAll("[data-command]")) {
      other.setAttribute("aria-selected", String(other === item));
    }
    if (!item) return input.removeAttribute("aria-activedescendant");
    item.id ||= `tiny-command-${Math.random().toString(36).slice(2, 10)}`;
    input.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  },
});

const paletteHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(paletteSignals, paletteTools);
  return {
    /**
     * Takes the palette's state, and listens for its shortcut until it
     * leaves the page.
     */
    adoptPalette: function (this: HTMLDialogElement & LifecycleElement) {
      signal.open.forInstance(this).value = this.open;
      const key = this.dataset.shortcut;
      if (!key) return;
      document.addEventListener("keydown", (event) => {
        if (
          !(event.ctrlKey || event.metaKey) || event.altKey ||
          event.key.toLowerCase() !== key
        ) return;
        event.preventDefault();
        const open = signal.open.forInstance(this);
        open.value = !open.value;
      }, { signal: this.abortController.signal });
    },
    /** Opens the palette afresh, or closes it, as `open` changes. */
    showPalette: function (this: HTMLDialogElement, event: SignalEvent) {
      const open = Boolean(event.signal.value);
      if (open === this.open) return;
      if (!open) return this.close();
      const input = this.querySelector("input")!;
      input.value = "";
      // Filters for the cleared query, through `filterCommands`.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      this.showModal();
      input.focus();
    },
    /** Notes a close however it came about. */
    paletteClosed: function (this: HTMLDialogElement) {
      signal.open.forInstance(this).value = false;
    },
    /** Shows the items holding every word of the query, then their groups. */
    filterCommands: function (this: HTMLDialogElement) {
      // Lower case, without accents, so "Cafe" matches "café".
      const fold = (text: string) =>
        text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
      const input = this.querySelector("input")!;
      const words = fold(input.value).split(/\s+/).filter(Boolean);
      for (const item of this.querySelectorAll<HTMLElement>("[data-command]")) {
        const text = fold(`${item.textContent} ${item.dataset.keywords ?? ""}`);
        item.hidden = !words.every((word) => text.includes(word));
      }
      for (
        const group of this.querySelectorAll<HTMLElement>('[role="group"]')
      ) {
        group.hidden = !group.querySelector("[data-command]:not([hidden])");
      }
      const shown = fn.shownItems(this);
      this.querySelector<HTMLElement>("[data-empty]")!.hidden =
        shown.length > 0;
      fn.activate(this, shown[0]);
    },
    /** Moves through the items with ↑ and ↓, and chooses one with Enter. */
    moveInPalette: function (this: HTMLDialogElement, event: KeyboardEvent) {
      const shown = fn.shownItems(this);
      const current = shown.findIndex((item) =>
        item.getAttribute("aria-selected") === "true"
      );
      if (event.key === "Enter") {
        if (current < 0 || event.isComposing) return;
        event.preventDefault();
        shown[current].click();
        return;
      }
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step || !shown.length) return;
      event.preventDefault();
      fn.activate(this, shown.at((current + step) % shown.length));
    },
    /** Marks the item under the pointer as the one Enter chooses. */
    pointToCommand: function (this: HTMLDialogElement, event: PointerEvent) {
      const item = (event.target as Element).closest?.("[data-command]") as
        | HTMLElement
        | null;
      if (item && item.getAttribute("aria-selected") !== "true") {
        fn.activate(this, item);
      }
    },
    /** Closes the palette once an item is chosen; a backdrop click too. */
    closeOnChoice: function (this: HTMLDialogElement, event: MouseEvent) {
      if (event.target === this) {
        const box = this.getBoundingClientRect();
        const inside = event.clientX >= box.left &&
          event.clientX <= box.right && event.clientY >= box.top &&
          event.clientY <= box.bottom;
        if (!inside && event.detail > 0) this.close();
        return;
      }
      if ((event.target as Element).closest?.("[data-command]")) this.close();
    },
    openPalette: function (this: HTMLButtonElement) {
      signal.open.forInstance(this).value = true;
    },
  };
});

const paletteStyles = new tiny.Styles(import.meta.url, {
  palette: css`
    width: min(36rem, calc(100vw - 2rem));
    max-height: min(28rem, calc(100vh - 6rem));
    margin: 12vh auto auto;
    padding: 0;
    border: 1px solid var(--palette-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    border-radius: 10px;
    background: var(--palette-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
    color: var(--palette-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    box-shadow: 0 16px 40px oklch(21% 0.032 264.7 / 0.25);
    overflow: hidden;

    &[open] {
      display: flex;
      flex-direction: column;
    }
    &::backdrop {
      background: var(--palette-backdrop, oklch(21% 0.032 264.7 / 0.35));
    }
    > input {
      padding: 0.875rem 1rem;
      border: none;
      border-bottom: 1px solid var(--palette-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
      background: none;
      color: inherit;
      font: inherit;
      font-size: 1rem;
    }
    > input:focus {
      outline: none;
    }
    > [role="listbox"] {
      flex: 1;
      padding: 0.375rem;
      overflow-y: auto;
    }
    [role="group"] + [role="group"] {
      margin-top: 0.375rem;
    }
    [data-heading] {
      padding: 0.375rem 0.625rem 0.25rem;
      color: var(--palette-muted, light-dark(oklch(55.1% 0.023 264.4), oklch(64.9% 0.023 264.4)));
      font-size: 0.75rem;
      font-weight: 600;
    }
    [data-empty] {
      margin: 0;
      padding: 1.5rem;
      color: var(--palette-muted, light-dark(oklch(55.1% 0.023 264.4), oklch(64.9% 0.023 264.4)));
      text-align: center;
    }
    [hidden] {
      display: none !important;
    }
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-sizing: border-box;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    text-decoration: none;
    cursor: pointer;

    &[hidden] {
      display: none;
    }
    &[aria-selected="true"] {
      background: var(--palette-active, light-dark(oklch(97.9% 0.021 166.1), oklch(22.1% 0.016 166.1)));
    }
    > kbd,
    > small {
      margin-left: auto;
      color: var(--palette-muted, light-dark(oklch(55.1% 0.023 264.4), oklch(64.9% 0.023 264.4)));
      font-size: 0.75rem;
    }
  `,
  trigger: css`
    display: inline-flex;
    align-items: center;
    gap: 1.5rem;

    kbd {
      color: var(--palette-muted, light-dark(oklch(55.1% 0.023 264.4), oklch(64.9% 0.023 264.4)));
      font-size: 0.75rem;
    }
    @media (scripting: none) {
      display: none;
    }
  `,
});

/**
 * `Palette` is the dialog holding `Group`s of `Item`s, and `Trigger` a
 * button opening it. Both expose `signal.open`, which opens the palette
 * when set true.
 */
export const CommandPaletteSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      paletteSignals,
      paletteHandlers,
      paletteStyles,
    );
    return {
      Trigger: instanced((props: {
        /** The key opening it with Ctrl or ⌘, shown beside the text. */
        shortcut?: string;
        children?: unknown;
      }) => (
        <button
          type="button"
          class={styled.trigger}
          aria-haspopup="dialog"
          onClick={fn.openPalette}
        >
          <span>{props.children ?? "Search…"}</span>
          <kbd>Ctrl {(props.shortcut ?? "k").toUpperCase()}</kbd>
        </button>
      ), [signal.open]),
      Palette: instanced((props: {
        /** Names the palette, and its search box, to assistive technology. */
        label?: string;
        placeholder?: string;
        /** Shown while nothing matches; default "No results." */
        empty?: unknown;
        /** The key opening it with Ctrl or ⌘; default `k`, `false` for none. */
        shortcut?: string | false;
        children?: unknown;
      }) => (
        <dialog
          class={styled.palette}
          aria-label={props.label ?? "Command palette"}
          data-shortcut={props.shortcut === false
            ? undefined
            : (props.shortcut ?? "k").toLowerCase()}
          onConnect={[signal.open, fn.adoptPalette]}
          onSignal={fn.showPalette}
          onClose={fn.paletteClosed}
          onInput={fn.filterCommands}
          onKeyDown={fn.moveInPalette}
          onPointerMove={fn.pointToCommand}
          onClick={fn.closeOnChoice}
        >
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-label={props.label ?? "Search commands"}
            placeholder={props.placeholder ?? "Type a command or search…"}
            autocomplete="off"
          />
          <div role="listbox" aria-label={props.label ?? "Commands"}>
            {props.children}
            <p data-empty hidden>{props.empty ?? "No results."}</p>
          </div>
        </dialog>
      ), [signal.open]),
      Group: (props: { heading: string; children?: unknown }) => (
        <div role="group" aria-label={props.heading}>
          <div data-heading aria-hidden="true">{props.heading}</div>
          {props.children}
        </div>
      ),
      Item: (props: {
        /** Makes the item a link. */
        href?: string;
        /** Runs when it is chosen, by click or Enter. */
        onClick?: HandlerProp<(event: MouseEvent) => unknown>;
        /** More words it matches, besides its text. */
        keywords?: string;
        /** A hint shown at its end, such as a shortcut. */
        hint?: string;
        children?: unknown;
      }) => {
        const hint = props.hint ? <small>{props.hint}</small> : null;
        return props.href
          ? (
            <a
              role="option"
              class={styled.item}
              href={props.href}
              tabindex="-1"
              data-command=""
              data-keywords={props.keywords}
              aria-selected="false"
              onClick={props.onClick}
            >
              {props.children}
              {hint}
            </a>
          )
          : (
            <button
              type="button"
              role="option"
              class={styled.item}
              tabindex="-1"
              data-command=""
              data-keywords={props.keywords}
              aria-selected="false"
              onClick={props.onClick}
            >
              {props.children}
              {hint}
            </button>
          );
      },
    };
  },
);
