/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A popover: content floating beside the button that opens it, closed by a
 * click elsewhere or Escape. As a menu, its items are moved through with the
 * arrow keys and close it when chosen.
 *
 * ```tsx
 * const { component } = await tiny.imports(PopoverSignalComponent);
 * const actions = component.instance();
 *
 * <actions.Trigger label="Patient actions">⋯</actions.Trigger>
 * <actions.Content menu label="Patient actions">
 *   <actions.Item href="/patients/12/edit">Edit</actions.Item>
 *   <actions.Item onClick={fn.archive}>Archive</actions.Item>
 * </actions.Content>
 * ```
 *
 * It is the browser's own `popover`: the content shows in the top layer,
 * above dialogs, and is placed with CSS anchor positioning beside whichever
 * trigger opened it. Its id reaches each trigger through a signal, as their
 * `popovertarget`, so the trigger and content sit wherever the page puts
 * them. Where anchor positioning is missing the content shows centred.
 *
 * A trigger the page styles itself, such as an avatar card, takes a `class`.
 * An item can open a dialog through `commandFor` and `command`, the
 * browser's invoker commands, closing the menu as it does:
 *
 * ```tsx
 * <account.Trigger class={styled.accountCard} menu>…</account.Trigger>
 * <account.Content menu side="top" matchTriggerWidth label="Account">
 *   <account.Item commandFor="password-dialog" command="show-modal">
 *     Change password
 *   </account.Item>
 * </account.Content>
 * ```
 *
 * Content holding a date input or other native picker can take `holdsPickers`.
 * On iPadOS the tap that dismisses a picker otherwise closes the popover too;
 * with it, that tap only dismisses the picker, and a later one closes as usual.
 *
 * Colours come from custom properties a caller may set on the content or any
 * ancestor: `--popover-surface`, `--popover-border`, `--popover-text`,
 * `--popover-muted` and `--popover-accent`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h, type JSX } from "../../jsx-runtime.ts";
import {
  type ExposedSignals,
  type HandlerProp,
  type InstanceSignals,
  optimized,
  type Signal,
  type SignalComponent,
} from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import type { SignalEvent } from "../../handlers/signals.ts";

const tiny = optimized(import.meta.url);

/**
 * Per instance: whether the content is open, and its id, which the content
 * writes as it connects and the triggers take as their `popovertarget`.
 */
const popoverSignals = new tiny.Signals(({ Signal, Scope }) =>
  new Scope(() => ({
    open: new Signal<boolean>(false),
    target: new Signal(""),
  }))
);

/** Helpers the handlers share, called through `fn`. */
const popoverTools = new tiny.Handlers({
  /** The content's menu items that can be chosen. */
  menuItems(content: HTMLElement): HTMLElement[] {
    return [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .filter((item) => !item.matches(":disabled, [aria-disabled='true']"));
  },
  /**
   * While open, closes content the browser won't close by itself on a click
   * outside it. A touch while a picker inside it has focus only dismisses the
   * picker, so the next one is what closes it.
   */
  closeOnOutsideClick(content: WatchingContent, open: boolean): void {
    content.outsideClicks?.abort();
    content.outsideClicks = undefined;
    if (!open) return;
    const watch = content.outsideClicks = new AbortController();
    let dismissingPicker = false;
    document.addEventListener("pointerdown", (event) => {
      const focused = document.activeElement;
      dismissingPicker = event.pointerType !== "mouse" &&
        content.contains(focused) && !!focused?.matches("input, select");
    }, { capture: true, signal: watch.signal });
    document.addEventListener("click", (event) => {
      if (!content.isConnected) {
        watch.abort();
        return;
      }
      const target = event.target as Element;
      if (
        content.contains(target) ||
        target.closest?.(`[popovertarget="${content.id}"]`)
      ) return;
      if (dismissingPicker) {
        dismissingPicker = false;
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      content.hidePopover();
    }, { capture: true, signal: watch.signal });
  },
});

/** Content closing itself on outside clicks, and what it listens with. */
type WatchingContent = HTMLElement & { outsideClicks?: AbortController };

const popoverHandlers = new tiny.Handlers(async () => {
  const { fn, signal } = await tiny.imports(popoverSignals, popoverTools);
  return {
    /** Gives the content an id, and its triggers that id. */
    adoptContent: function (this: HTMLElement) {
      this.id ||= `tiny-popover-${Math.random().toString(36).slice(2, 10)}`;
      signal.target.forInstance(this).value = this.id;
      signal.open.forInstance(this).value = this.matches(":popover-open");
    },
    /** Points the button at the content, as soon as its id is known. */
    linkTrigger: function (this: HTMLButtonElement) {
      const target = signal.target.forInstance(this).value;
      if (target) this.setAttribute("popovertarget", target);
    },
    /** Shows or hides the content as `open` changes. */
    showContent: function (this: HTMLElement, event: SignalEvent) {
      const open = Boolean(event.signal.value);
      if (open === this.matches(":popover-open")) return;
      if (open) this.showPopover();
      else this.hidePopover();
    },
    /** Marks content that can't sit beside its trigger as it opens. */
    placeContent: function (this: HTMLElement, event: Event) {
      if (
        (event as ToggleEvent).newState !== "open" ||
        !this.hasAttribute("data-center-when-narrow")
      ) return;
      const box = document.querySelector(`[popovertarget="${this.id}"]`)
        ?.getBoundingClientRect();
      this.toggleAttribute(
        "data-trigger-hidden",
        !box || box.bottom <= 0 || box.top >= innerHeight ||
          box.right <= 0 || box.left >= innerWidth,
      );
    },
    /**
     * Notes an open or close however it came about, and as a menu, focuses
     * its first item on opening.
     */
    contentToggled: function (this: HTMLElement, event: Event) {
      const open = (event as ToggleEvent).newState === "open";
      signal.open.forInstance(this).value = open;
      if (this.getAttribute("popover") === "manual") {
        fn.closeOnOutsideClick(this as WatchingContent, open);
      }
      if (open && this.getAttribute("role") === "menu") {
        fn.menuItems(this)[0]?.focus();
      }
    },
    /**
     * Closes content holding pickers on Escape, as the browser only does that
     * for the usual kind, and moves between a menu's items with the arrow keys,
     * Home and End.
     */
    moveInMenu: function (this: HTMLElement, event: KeyboardEvent) {
      if (event.key === "Escape" && this.getAttribute("popover") === "manual") {
        this.hidePopover();
        return;
      }
      if (this.getAttribute("role") !== "menu") return;
      const items = fn.menuItems(this);
      const current = items.indexOf(document.activeElement as HTMLElement);
      const keys: Record<string, number> = {
        ArrowDown: current + 1,
        ArrowUp: current < 0 ? -1 : current - 1,
        Home: 0,
        End: items.length - 1,
      };
      if (!(event.key in keys) || !items.length) return;
      event.preventDefault();
      items.at(keys[event.key] % items.length)?.focus();
    },
    /** Closes a menu once an item is chosen. */
    closeOnChoice: function (this: HTMLElement, event: MouseEvent) {
      const item = (event.target as Element).closest?.('[role="menuitem"]');
      if (item && this.getAttribute("role") === "menu") this.hidePopover();
    },
    closePopover: function (this: HTMLButtonElement) {
      signal.open.forInstance(this).value = false;
    },
  };
});

const centredCss = css`
  position: fixed;
  inset: 0;
  box-sizing: border-box;
  width: fit-content;
  height: fit-content;
  max-width: calc(100vw - 1rem);
  margin: auto;
  position-area: none;
  position-try-fallbacks: none;
`;

const popoverStyles = new tiny.Styles({
  content: css`
    min-width: 10rem;
    max-width: min(24rem, calc(100vw - 1rem));
    padding: 0.75rem;
    border: 1px solid var(--popover-border, light-dark(oklch(87.2% 0.009 258.3),
      oklch(32.8% 0.007 258.3)));
    border-radius: 8px;
    background: var(--popover-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
    color: var(--popover-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032
      264.7)));
    box-shadow: 0 8px 24px oklch(21% 0.032 264.7 / 0.16);
    transition: opacity 120ms ease, display 120ms allow-discrete,
      overlay 120ms allow-discrete;

    &:popover-open {
      @starting-style {
        opacity: 0;
      }
    }
    &:not(:popover-open) {
      opacity: 0;
    }
    &[role="menu"] {
      display: none;
      min-width: 12rem;
      padding: 0.25rem;
    }
    &[role="menu"]:popover-open {
      display: flex;
      flex-direction: column;
    }
    @supports (position-area: bottom) {
      inset: auto;
      margin: 0.25rem 0;
      position-area: bottom span-right;
      position-try-fallbacks: flip-block, flip-inline;

      &[data-side="top"] {
        position-area: top span-right;
      }
      &[data-side="right"] {
        margin: 0 0.25rem;
        position-area: right span-bottom;
      }
      &[data-side="left"] {
        margin: 0 0.25rem;
        position-area: left span-bottom;
      }
      &[data-match-trigger-width] {
        box-sizing: border-box;
        min-width: 0;
        max-width: none;
        width: anchor-size(width);
      }
    }
    /* Too tall to fit above or below a trigger mid-screen, so it can go beside it. */
    @supports (position-area: bottom) {
      &[data-tall] {
        position-try-fallbacks: flip-block, flip-inline,
          flip-block flip-inline, left span-all, right span-all;
      }
    }
    /* Beside its trigger there may be no room, so it leaves the anchor. */
    @media (max-width: 40rem) {
      &[data-center-when-narrow] {
        ${centredCss};
      }
    }
    /* Nor can it sit beside a trigger scrolled out of view. */
    &[data-trigger-hidden] {
      ${centredCss};
    }
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-sizing: border-box;
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: none;
    border-radius: 4px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    text-decoration: none;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      outline: none;
      background: var(--popover-accent, light-dark(oklch(97.9% 0.021 166.1),
        oklch(22.1% 0.016 166.1)));
    }
    &[data-variant="danger"] {
      color: light-dark(oklch(50.5% 0.19 27.5), oklch(75% 0.19 27.5));
    }
  `,
  separator: css`
    height: 1px;
    margin: 0.25rem 0;
    border: none;
    background: var(--popover-border, light-dark(oklch(87.2% 0.009 258.3),
      oklch(32.8% 0.007 258.3)));
  `,
  // The triggers need the page's script, so they stay hidden without it.
  scripted: css`
    @media (scripting: none) {
      display: none;
    }
  `,
});

/** The signals a popover exposes. */
type PopoverExposed = InstanceSignals<{ open: Signal<boolean> }>;

/** What `Trigger` takes. */
type TriggerProps = {
  /** Names the button, for one showing only an icon. */
  label?: string;
  /** Opens a `menu` Content, telling assistive technology so. */
  menu?: boolean;
  /** The page's own style, for a trigger it designs itself. */
  class?: string;
  children?: unknown;
};

/** What `Content` takes. */
type ContentProps = {
  /** Names the content to assistive technology. */
  label?: string;
  /** A menu of `Item`s, moved through with the arrow keys. */
  menu?: boolean;
  /** Which side of the trigger it shows on; default `bottom`. */
  side?: "top" | "bottom" | "left" | "right";
  /** As wide as the trigger, where anchor positioning is supported. */
  matchTriggerWidth?: boolean;
  /**
   * Centred on the screen on a narrow display, or when its trigger is out of
   * view, such as when an item in a menu opens it instead.
   */
  centerWhenNarrow?: boolean;
  /** Tall content, which also tries beside its trigger when it fits neither above nor below. */
  tall?: boolean;
  /** Holds a native picker, so the tap dismissing one doesn't close it too. */
  holdsPickers?: boolean;
  /** Its id, for a `popovertarget` of the page's own. */
  id?: string;
  children?: unknown;
};

/** What `Close` takes. */
type CloseProps = { label?: string; children?: unknown };

/** What a menu `Item` takes. */
type ItemProps = {
  /** Makes the item a link. */
  href?: string;
  /** Runs when it is chosen, by click or Enter. */
  onClick?: HandlerProp<(event: MouseEvent) => unknown>;
  /**
   * The id of an element a button item invokes, such as a `<dialog>`,
   * with `command` saying what to do, such as `show-modal`.
   */
  commandFor?: string;
  command?: string;
  /** `danger` for a destructive choice. */
  variant?: "danger";
  disabled?: boolean;
  children?: unknown;
};

/**
 * `Trigger` opens and closes the `Content`, wherever each sits; `Close`
 * closes it from inside. A menu's `Item`s are links or buttons of the
 * caller's, and `Separator` divides them. The popover exposes
 * `signal.open`, which opens the content when set true.
 */
export const PopoverSignalComponent: SignalComponent<{
  signal: ExposedSignals<PopoverExposed>;
  Trigger: (props: TriggerProps) => JSX.Element;
  Content: (props: ContentProps) => JSX.Element;
  Close: (props: CloseProps) => JSX.Element;
  Item: (props: ItemProps) => JSX.Element;
  Separator: JSX.Element;
}> = new tiny.SignalComponent(
  async () => {
    const { fn, signal, styled } = await tiny.imports(
      popoverSignals,
      popoverHandlers,
      popoverStyles,
    );
    return {
      signal: [signal.open],
      Trigger: (props: TriggerProps) => (
        <button
          type="button"
          class={styled.mergeClasses(styled.scripted, props.class)}
          aria-haspopup={props.menu ? "menu" : undefined}
          aria-label={props.label}
          title={props.label}
          onConnect={[signal.target.subscribe, fn.linkTrigger]}
          onSignal={fn.linkTrigger}
        >
          {props.children ?? "Open"}
        </button>
      ),
      Content: (props: ContentProps) => (
        <div
          popover={props.holdsPickers ? "manual" : "auto"}
          id={props.id}
          class={styled.content}
          role={props.menu ? "menu" : "dialog"}
          aria-label={props.label}
          data-side={props.side}
          data-match-trigger-width={props.matchTriggerWidth ? "" : undefined}
          data-center-when-narrow={props.centerWhenNarrow ? "" : undefined}
          data-tall={props.tall ? "" : undefined}
          onConnect={[signal.open.subscribe, fn.adoptContent]}
          onSignal={fn.showContent}
          onBeforeToggle={fn.placeContent}
          onToggle={fn.contentToggled}
          onKeyDown={fn.moveInMenu}
          onClick={fn.closeOnChoice}
        >
          {props.children}
        </div>
      ),
      Close: (props: CloseProps) => (
        <button
          type="button"
          aria-label={props.label}
          onClick={fn.closePopover}
        >
          {props.children ?? "Close"}
        </button>
      ),
      Item: (props: ItemProps) =>
        props.href
          ? (
            <a
              role="menuitem"
              class={styled.item}
              href={props.href}
              tabindex="-1"
              data-variant={props.variant}
              onClick={props.onClick}
            >
              {props.children}
            </a>
          )
          : (
            <button
              type="button"
              role="menuitem"
              class={styled.item}
              tabindex="-1"
              data-variant={props.variant}
              disabled={props.disabled}
              commandfor={props.commandFor}
              command={props.command}
              onClick={props.onClick}
            >
              {props.children}
            </button>
          ),
      Separator: <hr role="separator" class={styled.separator} />,
    };
  },
);
