/**
 * A dialog opened by buttons wherever the page puts them, and a wrapper
 * asking to confirm before a submit button's form submits.
 *
 * ```tsx
 * const { component } = await tiny.imports(DialogSignalComponent);
 * const editor = component.instance();
 *
 * <editor.Open>Edit details</editor.Open>
 * <editor.Panel label="Edit details">
 *   <editor.Close />
 *   <form method="post" action="/patients/12">…</form>
 * </editor.Panel>
 *
 * const deletion = component.instance();
 * <form method="post" action="/todo/3/delete">
 *   <deletion.Confirm message="Delete this task?" confirmLabel="Delete">
 *     <button type="submit" class="danger">Delete</button>
 *   </deletion.Confirm>
 * </form>
 * ```
 *
 * `Confirm` is the caller's markup, not a component boundary, so the page's
 * styles keep reaching the button it wraps.
 *
 * A `Panel` closes on Escape, on its `Close`, on a click on its backdrop
 * and when a form inside it submits (unless the submit was prevented, or the
 * form is marked `data-keep-open`). Focus returns to what opened it.
 *
 * Colours come from custom properties a caller may set on the panel or any
 * ancestor: `--dialog-surface`, `--dialog-border`, `--dialog-text` and
 * `--dialog-backdrop`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { transparent } from "../../componentScope.ts";
import type { SignalEvent } from "../../handlers/signals.ts";

/** Whether the dialog is open, one per instance. */
const dialogSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({ open: new Signal<boolean>(false) })),
);

const dialogHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(dialogSignals);
  return {
    /** Opens a panel rendered `open`, and takes its state. */
    adoptDialog: function (this: HTMLDialogElement) {
      if (this.hasAttribute("data-start-open") && !this.open) {
        if (this.hasAttribute("data-modal")) this.showModal();
        else this.show();
      }
      signal.open.forInstance(this).value = this.open;
    },
    /** Opens or closes the panel as `open` changes. */
    showDialog: function (this: HTMLDialogElement, event: SignalEvent) {
      const open = Boolean(event.signal.value);
      if (open === this.open) return;
      if (!open) this.close();
      else if (this.hasAttribute("data-modal")) this.showModal();
      else this.show();
    },
    /** Notes a close however it came about: Escape, a form, `Close`. */
    dialogClosed: function (this: HTMLDialogElement) {
      signal.open.forInstance(this).value = false;
    },
    /** Closes a modal panel on a click outside its box. */
    closeOnBackdrop: function (this: HTMLDialogElement, event: MouseEvent) {
      if (event.target !== this || !this.hasAttribute("data-modal")) return;
      const box = this.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right &&
        event.clientY >= box.top && event.clientY <= box.bottom;
      // A keyboard "click" has no position, and is not on the backdrop.
      if (!inside && event.detail > 0) this.close();
    },
    /** Closes the panel once a form inside it submits. */
    closeOnSubmit: function (this: HTMLDialogElement, event: SubmitEvent) {
      const form = event.target as HTMLFormElement;
      if (event.defaultPrevented || form.hasAttribute("data-keep-open")) {
        return;
      }
      this.close();
    },
    openDialog: function (this: HTMLButtonElement) {
      signal.open.forInstance(this).value = true;
    },
    closeDialog: function (this: HTMLButtonElement) {
      signal.open.forInstance(this).value = false;
    },
    /**
     * Asks first: a click on a submit button the wrapper holds waits for the
     * answer in its dialog.
     */
    askToConfirm: function (this: HTMLElement, event: MouseEvent) {
      const button = (event.target as Element).closest?.("button");
      const dialog = this.querySelector(":scope > dialog");
      if (
        event.defaultPrevented || !button || button.type !== "submit" ||
        !(dialog instanceof HTMLDialogElement) || dialog.contains(button)
      ) return;
      event.preventDefault();
      dialog.showModal();
      // `autofocus` alone loses to some pages' focus handling.
      dialog.querySelector<HTMLElement>("[autofocus]")?.focus();
    },
    /** Closes the dialog, submitting through the wrapped button on a yes. */
    answerConfirm: function (this: HTMLDialogElement, event: MouseEvent) {
      const answer = (event.target as Element).closest?.("[data-answer]");
      if (!answer) return;
      this.close();
      if (answer.getAttribute("data-answer") !== "yes") return;
      const button = [...this.parentElement!.querySelectorAll("button")]
        .find((button) => button.type === "submit" && !this.contains(button));
      button?.form?.requestSubmit(button);
    },
  };
});

const dialogStyles = new tiny.Styles(import.meta.url, {
  panel: css`
    max-width: min(32rem, calc(100vw - 2rem));
    padding: 1.25rem;
    border: 1px solid var(--dialog-border, #d1d5db);
    border-radius: 8px;
    background: var(--dialog-surface, #fff);
    color: var(--dialog-text, #111827);
    box-shadow: 0 12px 32px rgb(17 24 39 / 0.2);

    &::backdrop {
      background: var(--dialog-backdrop, rgb(17 24 39 / 0.45));
    }
  `,
  closeButton: css`
    float: right;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    margin: -0.5rem -0.5rem 0 0.5rem;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: inherit;
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
  `,
  // The open buttons need the page's script, so they stay hidden without it.
  scripted: css`
    @media (scripting: none) {
      display: none;
    }
  `,
  answers: css`
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  `,
});

/**
 * `Panel` is the dialog, `Open` a button opening it and `Close` a button
 * closing it; all three expose `signal.open`, which opens the panel when set
 * true. `Confirm` stands alone: it wraps a submit button, and its own dialog
 * asks before the button's form submits, in place of `confirm()`.
 */
export const DialogSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      dialogSignals,
      dialogHandlers,
      dialogStyles,
    );
    return {
      Open: instanced((props: { children?: unknown; label?: string }) => (
        <button
          type="button"
          class={styled.scripted}
          aria-haspopup="dialog"
          aria-label={props.label}
          onClick={fn.openDialog}
        >
          {props.children ?? "Open"}
        </button>
      ), [signal.open]),
      Panel: instanced((props: {
        /** Names the dialog to assistive technology. */
        label?: string;
        /** Whether the page stays usable while it is open. Default false. */
        modeless?: boolean;
        /** Opens it as the page loads. */
        open?: boolean;
        children?: unknown;
      }) => (
        <dialog
          class={styled.panel}
          aria-label={props.label}
          data-modal={props.modeless ? undefined : ""}
          data-start-open={props.open ? "" : undefined}
          onConnect={[signal.open, fn.adoptDialog]}
          onSignal={fn.showDialog}
          onClose={fn.dialogClosed}
          onClick={fn.closeOnBackdrop}
          onSubmit={fn.closeOnSubmit}
        >
          {props.children}
        </dialog>
      ), [signal.open]),
      Close: instanced(
        (props: { children?: unknown; label?: string }) => (
          <button
            type="button"
            class={props.children ? undefined : styled.closeButton}
            aria-label={props.label ?? (props.children ? undefined : "Close")}
            title={props.children ? undefined : "Close"}
            onClick={fn.closeDialog}
          >
            {props.children ?? "×"}
          </button>
        ),
        [signal.open],
      ),
      Confirm: transparent((props: {
        /** The question asked. */
        message: string;
        /** The yes button's text; by default "Confirm". */
        confirmLabel?: string;
        cancelLabel?: string;
        /** The submit button to ask before, with the page's own attributes. */
        children?: unknown;
      }) => (
        <tiny-confirm onClick={fn.askToConfirm}>
          {props.children}
          <dialog
            class={styled.panel}
            aria-label={props.message}
            onClick={fn.answerConfirm}
          >
            <p>{props.message}</p>
            <div class={styled.answers}>
              <button type="button" data-answer="no" autofocus>
                {props.cancelLabel ?? "Cancel"}
              </button>
              <button type="button" data-answer="yes">
                {props.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </dialog>
        </tiny-confirm>
      )),
    };
  },
);
