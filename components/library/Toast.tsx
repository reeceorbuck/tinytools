/**
 * Toasts: brief notices stacked in a corner of the page, dismissed after a
 * few seconds or by their ×. A `Toaster` shows them; a `Trigger` button
 * raises one, and a `Toast` raises one as it arrives in the page, so a server
 * can send one in any response.
 *
 * ```tsx
 * const { component } = await tiny.imports(ToastSignalComponent);
 * const toasts = component.instance();
 *
 * // Once, in the layout:
 * <toasts.Toaster position="bottom-right" />
 *
 * <toasts.Trigger message="Copied" variant="success">Copy</toasts.Trigger>
 *
 * // In a page, a partial or an SSE update, after a save:
 * <toasts.Toast variant="success">
 *   Saved. <a href="/patients/12">View patient</a>
 * </toasts.Toast>
 * ```
 *
 * The toasts are page-wide, not per instance: there is one `Toaster` on a
 * page, and every `Trigger` and `Toast` reaches it, whichever instance or
 * request rendered them. A `Toast`'s children are the caller's markup,
 * handlers included; any element inside one marked `data-toast-close` closes
 * it when clicked. Toasts pause while the pointer is on them and stay while
 * focus is inside one. A toast raised while a modal dialog is open shows above
 * it, but like the rest of the page cannot be clicked until the dialog
 * closes.
 *
 * Colours come from custom properties a caller may set on the toaster or any
 * ancestor: `--toast-surface`, `--toast-border`, `--toast-text`,
 * `--toast-muted`, and the variants' `--toast-success`, `--toast-error` and
 * `--toast-info`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";

/**
 * A toast raised but not yet shown: text, or a `Toast`'s markup in `html`.
 * `duration` in milliseconds overrides the toaster's; 0 keeps it until
 * closed.
 */
type PendingToast = {
  message?: string;
  description?: string;
  html?: string;
  variant?: string;
  duration?: number;
};

/**
 * One queue for the page: the raising parts append to it and the toaster
 * moves them out, so they meet only through the signal.
 */
const toastSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal }) => ({ queue: new Signal<PendingToast[]>([]) }),
);

/** A shown toast, with the time it has left while paused. */
type ToastElement = HTMLElement & {
  toastTimer?: ReturnType<typeof setTimeout>;
  toastRemaining?: number;
  toastStarted?: number;
};

/**
 * Helpers the handlers share, called through `fn`: a handler factory's own
 * locals do not reach the browser.
 */
const toastTools = new tiny.Handlers(import.meta.url, {
  /**
   * Starts the toast's countdown, unless it stays until closed. Focus inside
   * holds it a second at a time, so a keyboard has time to reach its links;
   * at the end it closes as its × would.
   */
  countDown(toast: ToastElement): void {
    if (!toast.toastRemaining) return;
    const arm = (time: number) => {
      toast.toastStarted = Date.now();
      toast.toastTimer = setTimeout(() => {
        if (toast.matches(":focus-within")) arm(1000);
        else toast.querySelector<HTMLElement>("[data-toast-close]")?.click();
      }, time);
    };
    arm(toast.toastRemaining);
  },
  /** Slides the toast out, then removes it. */
  dismiss(toast: ToastElement): void {
    clearTimeout(toast.toastTimer);
    if (toast.hasAttribute("data-leaving")) return;
    toast.setAttribute("data-leaving", "");
    const remove = () => toast.remove();
    toast.addEventListener("transitionend", remove, { once: true });
    // Reduced motion, or a hidden tab, may never end a transition.
    setTimeout(remove, 400);
  },
});

const toastHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(toastSignals, toastTools);
  return {
    /**
     * Shows the queued toasts. Bound to the toaster's `onConnect` and
     * `onSignal`, so it runs whenever a part raises one.
     */
    showToasts: function (this: HTMLElement) {
      const queue = signal.queue.value;
      if (!queue.length) return;
      signal.queue.value = [];
      for (const entry of queue) {
        const toast: ToastElement = document.createElement("div");
        toast.className = this.dataset.toastClass ?? "";
        toast.setAttribute(
          "role",
          entry.variant === "error" ? "alert" : "status",
        );
        toast.setAttribute("data-toast", "");
        if (entry.variant) toast.dataset.variant = entry.variant;
        const body = document.createElement("div");
        if (entry.html !== undefined) {
          body.innerHTML = entry.html;
        } else {
          const message = document.createElement("strong");
          message.textContent = entry.message ?? "";
          body.append(message);
          if (entry.description) {
            const description = document.createElement("p");
            description.textContent = entry.description;
            body.append(description);
          }
        }
        const close = document.createElement("button");
        close.type = "button";
        close.className = this.dataset.closeClass ?? "";
        close.setAttribute("data-toast-close", "");
        close.setAttribute("aria-label", "Close");
        close.title = "Close";
        close.textContent = "×";
        toast.append(body, close);
        toast.toastRemaining = entry.duration ??
          Number(this.dataset.duration ?? 5000);
        this.append(toast);
        if (!this.matches(":hover")) fn.countDown(toast);
      }
      // The newest shows on top of a modal dialog opened since the last.
      if (this.matches(":popover-open")) this.hidePopover();
      this.showPopover?.();
    },
    /** Closes the toast holding a clicked `data-toast-close`. */
    closeToast: function (this: HTMLElement, event: MouseEvent) {
      const close = (event.target as Element).closest?.("[data-toast-close]");
      const toast = close?.closest<ToastElement>("[data-toast]");
      if (toast && toast.parentElement === this) fn.dismiss(toast);
    },
    /** Pauses every toast's countdown while the pointer is on them. */
    pauseToasts: function (this: HTMLElement) {
      for (const toast of this.children as Iterable<ToastElement>) {
        if (toast.toastTimer === undefined) continue;
        clearTimeout(toast.toastTimer);
        toast.toastTimer = undefined;
        toast.toastRemaining = Math.max(
          (toast.toastRemaining ?? 0) - (Date.now() - toast.toastStarted!),
          1000,
        );
      }
    },
    /** Resumes the countdowns once the pointer leaves. */
    resumeToasts: function (this: HTMLElement) {
      for (const toast of this.children as Iterable<ToastElement>) {
        if (toast.toastTimer === undefined) fn.countDown(toast);
      }
    },
    /** Raises the button's toast. */
    raiseToast: function (this: HTMLButtonElement) {
      const { message, description, variant, duration } = this.dataset;
      signal.queue.value = [...signal.queue.value, {
        message,
        description,
        variant,
        duration: duration === undefined ? undefined : Number(duration),
      }];
    },
    /** Raises this element's markup as a toast, and leaves the page. */
    raiseOwnToast: function (this: HTMLElement) {
      const { variant, duration } = this.dataset;
      signal.queue.value = [...signal.queue.value, {
        html: this.innerHTML,
        variant,
        duration: duration === undefined ? undefined : Number(duration),
      }];
      this.remove();
    },
  };
});

const toastStyles = new tiny.Styles(import.meta.url, {
  toaster: css`
    position: fixed;
    inset: auto 1rem 1rem auto;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(22rem, calc(100vw - 2rem));
    margin: 0;
    padding: 0;
    border: none;
    background: none;
    overflow: visible;

    &:empty {
      display: none;
    }
    &[data-position^="top"] {
      inset-block: 1rem auto;
      flex-direction: column-reverse;
    }
    &[data-position$="left"] {
      inset-inline: 1rem auto;
    }
    &[data-position$="center"] {
      inset-inline: 0;
      margin-inline: auto;
    }
  `,
  toast: css`
    --toast-accent: var(--toast-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));

    display: flex;
    align-items: start;
    gap: 0.75rem;
    padding: 0.75rem 0.75rem 0.75rem 1rem;
    border: 1px solid var(--toast-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    border-left: 4px solid var(--toast-accent);
    border-radius: 8px;
    background: var(--toast-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
    color: var(--toast-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    box-shadow: 0 8px 24px oklch(21% 0.032 264.7 / 0.16);
    transition: opacity 200ms ease, translate 200ms ease;

    @starting-style {
      opacity: 0;
      translate: 0 0.75rem;
    }
    &[data-leaving] {
      opacity: 0;
      translate: 1rem 0;
    }
    &[data-variant="success"] {
      --toast-accent: var(--toast-success, oklch(50.8% 0.105 165.6));
    }
    &[data-variant="error"] {
      --toast-accent: var(--toast-error, oklch(50.5% 0.19 27.5));
    }
    &[data-variant="info"] {
      --toast-accent: var(--toast-info, oklch(48.8% 0.217 264.4));
    }
    > div {
      flex: 1;
      min-width: 0;
    }
    p {
      margin: 0.125rem 0 0;
      color: var(--toast-muted, light-dark(oklch(44.6% 0.026 256.8), oklch(75.4% 0.026 256.8)));
      font-size: 0.875rem;
    }
    @media (prefers-reduced-motion: reduce) {
      transition: opacity 200ms ease;
      translate: none !important;
    }
  `,
  closeButton: css`
    display: grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    margin: -0.25rem -0.25rem 0 0;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--toast-muted, light-dark(oklch(44.6% 0.026 256.8), oklch(75.4% 0.026 256.8)));
    font-size: 1.125rem;
    line-height: 1;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      background: var(--toast-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
      color: var(--toast-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    }
  `,
  // The buttons need the page's script, so they stay hidden without it.
  scripted: css`
    @media (scripting: none) {
      display: none;
    }
  `,
});

/** Where the toasts stack. */
type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** What raises a toast besides its content. */
type RaiseProps = {
  /** `success`, `error` (announced at once) or `info`; plain by default. */
  variant?: "success" | "error" | "info";
  /** Milliseconds it shows for, overriding the toaster's; 0 until closed. */
  duration?: number;
};

/**
 * `Toaster` shows the toasts, `Trigger` is a button raising one, and `Toast`
 * raises its children as one when it reaches the page. None exposes
 * signals.
 */
export const ToastSignalComponent = new tiny.SignalComponent(async () => {
  const { fn, signal, styled } = await tiny.imports(
    toastSignals,
    toastHandlers,
    toastStyles,
  );
  return {
    Toaster: (props: {
      /** Default `bottom-right`. */
      position?: ToastPosition;
      /** Milliseconds each toast shows for; default 5000, 0 until closed. */
      duration?: number;
      /** Names the region to assistive technology; default "Notifications". */
      label?: string;
    }) => (
      <tiny-toaster
        class={styled.toaster}
        popover="manual"
        role="region"
        aria-label={props.label ?? "Notifications"}
        data-position={props.position}
        data-duration={props.duration}
        data-toast-class={styled.toast}
        data-close-class={styled.closeButton}
        onConnect={[signal.queue, fn.showToasts]}
        onSignal={fn.showToasts}
        onClick={fn.closeToast}
        onPointerEnter={fn.pauseToasts}
        onPointerLeave={fn.resumeToasts}
      />
    ),
    Trigger: (
      props: RaiseProps & {
        message: string;
        description?: string;
        label?: string;
        children?: unknown;
      },
    ) => (
      <button
        type="button"
        class={styled.scripted}
        aria-label={props.label}
        data-message={props.message}
        data-description={props.description}
        data-variant={props.variant}
        data-duration={props.duration}
        onClick={fn.raiseToast}
      >
        {props.children ?? props.message}
      </button>
    ),
    Toast: (props: RaiseProps & { children?: unknown }) => (
      <tiny-toast
        hidden
        data-variant={props.variant}
        data-duration={props.duration}
        onConnect={fn.raiseOwnToast}
      >
        {props.children}
      </tiny-toast>
    ),
  };
});
