/**
 * Tooltips and hover cards: a note, or a card of richer content, shown beside
 * an element while the pointer rests on it or it has focus.
 *
 * ```tsx
 * const { component } = await tiny.imports(TooltipSignalComponent);
 * const save = component.instance();
 * const patient = component.instance();
 *
 * <save.Trigger><button>💾</button></save.Trigger>
 * <save.Tip>Save the chart (Ctrl S)</save.Tip>
 *
 * <patient.Trigger><a href="/patients/12">Ann Lee</a></patient.Trigger>
 * <patient.Card>
 *   <strong>Ann Lee</strong> · last seen 3 June · <a href="/patients/12/xrays">X-rays</a>
 * </patient.Card>
 * ```
 *
 * A `Tip` is plain text, describing the trigger's first focusable element
 * to assistive technology (`aria-describedby`); it shows on hover or focus
 * and Escape hides it. A `Card` is for the pointer: it shows on hover and
 * stays while the pointer moves onto it, so its links can be followed.
 * Whatever a card holds must be reachable some other way too, as the
 * trigger's link is.
 *
 * Both are the browser's own `popover`, in the top layer above dialogs,
 * placed beside the trigger with CSS anchor positioning where the browser
 * has it, and by script where not.
 *
 * Colours come from custom properties a caller may set on the content or any
 * ancestor: `--tooltip-surface` and `--tooltip-text` for a tip, and
 * `--hovercard-surface`, `--hovercard-border` and `--hovercard-text` for a
 * card.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import type { LifecycleElement } from "../../lifecycleElement.ts";

/**
 * Per instance: whether the tip or card is showing, and its id, which it
 * writes as it connects and its triggers find it by.
 */
const tooltipSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({
      open: new Signal<boolean>(false),
      target: new Signal(""),
    })),
);

/** A tip or card, holding its pending show or hide and its trigger. */
type Content = HTMLElement & {
  tipTimer?: ReturnType<typeof setTimeout>;
  tipAnchor?: HTMLElement;
};

/** Helpers the handlers share, called through `fn`. */
const tooltipTools = new tiny.Handlers(import.meta.url, {
  /**
   * Marks the trigger as the content's, and for a tip, has the trigger's
   * first focusable element described by it.
   */
  link(trigger: HTMLElement, target: string): void {
    if (!target) return;
    trigger.dataset.for = target;
    const content = document.getElementById(target);
    if (content?.getAttribute("role") !== "tooltip") return;
    const focusable = "a[href], button, input, select, textarea, [tabindex]";
    const described = trigger.matches(focusable)
      ? trigger
      : trigger.querySelector(focusable);
    (described ?? trigger).setAttribute("aria-describedby", target);
  },
  /**
   * Shows the content beside `anchor`, or hides it, once its delay passes;
   * a newer call replaces a pending one. `delay` overrides the content's.
   */
  schedule(
    content: Content,
    open: boolean,
    anchor?: HTMLElement,
    delay?: number,
  ): void {
    clearTimeout(content.tipTimer);
    if (open === content.matches(":popover-open")) return;
    delay ??= Number(
      (open ? content.dataset.openDelay : content.dataset.closeDelay) ?? 0,
    );
    content.tipTimer = setTimeout(() => {
      if (!content.isConnected) return;
      if (!open) return content.hidePopover();
      content.tipAnchor = anchor;
      // `source` anchors the content to its trigger for CSS positioning.
      (content as unknown as {
        showPopover(options: { source?: HTMLElement }): void;
      }).showPopover({ source: anchor });
    }, delay);
  },
  /**
   * Places the content beside its trigger, where CSS anchor positioning is
   * missing: on its preferred side if it fits, else the opposite one.
   */
  place(content: Content): void {
    if (CSS.supports("position-area: top")) return;
    const anchor = content.tipAnchor ??
      document.querySelector<HTMLElement>(`[data-for="${content.id}"]`);
    if (!anchor) return;
    const gap = 6;
    const edge = 8;
    const box = anchor.getBoundingClientRect();
    const { width, height } = content.getBoundingClientRect();
    const above = box.top - gap - height;
    const below = box.bottom + gap;
    const top = content.dataset.side === "top"
      ? (above >= edge ? above : below)
      : (below + height <= innerHeight - edge ? below : above);
    const left = Math.min(
      Math.max(edge, box.left + box.width / 2 - width / 2),
      innerWidth - edge - width,
    );
    content.style.margin = "0";
    content.style.inset = `${Math.max(edge, top)}px auto auto ${left}px`;
  },
});

const tooltipHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(tooltipSignals, tooltipTools);
  return {
    /** Gives the content an id, and its triggers that id. */
    adoptTip: function (this: HTMLElement) {
      this.id ||= `tiny-tip-${Math.random().toString(36).slice(2, 10)}`;
      signal.target.forInstance(this).value = this.id;
      signal.open.forInstance(this).value = this.matches(":popover-open");
    },
    /** Shows the content as focus enters the trigger, until it leaves. */
    adoptTrigger: function (this: HTMLElement & LifecycleElement) {
      const listening = { signal: this.abortController.signal };
      const content = () =>
        document.getElementById(this.dataset.for ?? "") as Content | null;
      this.addEventListener("focusin", () => {
        const tip = content();
        if (tip) fn.schedule(tip, true, this);
      }, listening);
      this.addEventListener("focusout", (event) => {
        const tip = content();
        if (tip && !this.contains(event.relatedTarget as Node)) {
          fn.schedule(tip, false);
        }
      }, listening);
      fn.link(this, signal.target.forInstance(this).value);
    },
    linkTrigger: function (this: HTMLElement) {
      fn.link(this, signal.target.forInstance(this).value);
    },
    enterTrigger: function (this: HTMLElement) {
      const content = document.getElementById(this.dataset.for ?? "");
      if (content) fn.schedule(content, true, this);
    },
    leaveTrigger: function (this: HTMLElement) {
      const content = document.getElementById(this.dataset.for ?? "");
      if (content) fn.schedule(content, false);
    },
    /** Hides the content at once on Escape. */
    escapeTrigger: function (this: HTMLElement, event: KeyboardEvent) {
      const content = document.getElementById(this.dataset.for ?? "");
      if (event.key !== "Escape" || !content?.matches(":popover-open")) return;
      clearTimeout((content as Content).tipTimer);
      content.hidePopover();
    },
    /** Keeps a card showing while the pointer is on it. */
    enterCard: function (this: Content) {
      fn.schedule(this, true, this.tipAnchor);
    },
    leaveCard: function (this: Content) {
      fn.schedule(this, false);
    },
    /** Shows or hides the content at once as `open` changes. */
    showTip: function (this: Content) {
      const open = signal.open.forInstance(this).value;
      if (open === this.matches(":popover-open")) return;
      const anchor = this.tipAnchor ??
        document.querySelector<HTMLElement>(`[data-for="${this.id}"]`) ??
        undefined;
      fn.schedule(this, open, anchor, 0);
    },
    /** Notes a show or hide however it came about, and places a shown one. */
    tipToggled: function (this: Content, event: Event) {
      const open = (event as ToggleEvent).newState === "open";
      signal.open.forInstance(this).value = open;
      if (open) fn.place(this);
    },
  };
});

const tooltipStyles = new tiny.Styles(import.meta.url, {
  trigger: css`
    display: inline-block;
  `,
  tip: css`
    max-width: min(18rem, calc(100vw - 1rem));
    padding: 0.3rem 0.55rem;
    border: none;
    border-radius: 6px;
    background: var(--tooltip-surface, oklch(21% 0.032 264.7));
    color: var(--tooltip-text, oklch(98.5% 0.002 247.8));
    font-size: 0.8125rem;
    line-height: 1.35;
    pointer-events: none;
    transition: opacity 100ms ease, display 100ms allow-discrete,
      overlay 100ms allow-discrete;

    &:popover-open {
      @starting-style {
        opacity: 0;
      }
    }
    &:not(:popover-open) {
      opacity: 0;
    }
    @supports (position-area: top) {
      inset: auto;
      margin: 6px;
      position-area: top;
      position-try-fallbacks: flip-block;

      &[data-side="bottom"] {
        position-area: bottom;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  card: css`
    width: max-content;
    max-width: min(20rem, calc(100vw - 1rem));
    padding: 0.875rem 1rem;
    border: 1px solid var(--hovercard-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    border-radius: 10px;
    background: var(--hovercard-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
    color: var(--hovercard-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    box-shadow: 0 8px 24px oklch(21% 0.032 264.7 / 0.16);
    transition: opacity 150ms ease, translate 150ms ease,
      display 150ms allow-discrete, overlay 150ms allow-discrete;

    &:popover-open {
      @starting-style {
        opacity: 0;
        translate: 0 -4px;
      }
    }
    &:not(:popover-open) {
      opacity: 0;
    }
    @supports (position-area: bottom) {
      inset: auto;
      margin: 6px;
      position-area: bottom;
      position-try-fallbacks: flip-block;

      &[data-side="top"] {
        position-area: top;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
});

/** How long the pointer rests before showing, and leaves before hiding. */
type Delays = {
  /** Milliseconds before it shows; default 500 for a tip, 600 for a card. */
  delay?: number;
  /** Milliseconds before it hides; default 0 for a tip, 300 for a card. */
  closeDelay?: number;
  /** Which side of the trigger it shows on, if there is room. */
  side?: "top" | "bottom";
  /** Its id, for the page's own use. */
  id?: string;
  children?: unknown;
};

/**
 * `Trigger` wraps the element the content belongs to; `Tip` is a short note
 * and `Card` richer content, one per instance. All three expose
 * `signal.open`, which shows the content when set true.
 */
export const TooltipSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      tooltipSignals,
      tooltipHandlers,
      tooltipStyles,
    );
    return {
      Trigger: instanced((props: { children?: unknown }) => (
        <span
          class={styled.trigger}
          onConnect={[signal.target, fn.adoptTrigger]}
          onSignal={fn.linkTrigger}
          onPointerEnter={fn.enterTrigger}
          onPointerLeave={fn.leaveTrigger}
          onKeyDown={fn.escapeTrigger}
        >
          {props.children}
        </span>
      ), [signal.open]),
      Tip: instanced((props: Delays) => (
        <div
          popover="manual"
          role="tooltip"
          id={props.id}
          class={styled.tip}
          data-side={props.side}
          data-open-delay={String(props.delay ?? 500)}
          data-close-delay={String(props.closeDelay ?? 0)}
          onConnect={[signal.open, fn.adoptTip]}
          onSignal={fn.showTip}
          onToggle={fn.tipToggled}
        >
          {props.children}
        </div>
      ), [signal.open]),
      Card: instanced((props: Delays & { label?: string }) => (
        <div
          popover="manual"
          id={props.id}
          class={styled.card}
          aria-label={props.label}
          data-side={props.side}
          data-open-delay={String(props.delay ?? 600)}
          data-close-delay={String(props.closeDelay ?? 300)}
          onConnect={[signal.open, fn.adoptTip]}
          onSignal={fn.showTip}
          onToggle={fn.tipToggled}
          onPointerEnter={fn.enterCard}
          onPointerLeave={fn.leaveCard}
        >
          {props.children}
        </div>
      ), [signal.open]),
    };
  },
);
