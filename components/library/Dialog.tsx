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
 * Given an `id`, the browser's invoker commands open it too, from anywhere on
 * the page (`<button commandfor="…" command="show-modal">`), such as a
 * popover menu's item. With `restoreOnClose`, its content goes back to how it
 * was rendered whenever it closes: a form whose server responses replace it
 * with errors or a confirmation starts afresh the next time it opens.
 *
 * Colours come from custom properties a caller may set on the panel or any
 * ancestor: `--dialog-surface`, `--dialog-border`, `--dialog-text` and
 * `--dialog-backdrop`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h, type JSX } from "../../jsx-runtime.ts";
import {
  type InstancedComponent,
  type InstanceSignals,
  type Signal,
  type SignalComponent,
  tiny,
} from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { transparent } from "../../componentScope.ts";
import type { SignalEvent } from "../../handlers/signals.ts";

/** Whether the dialog is open, one per instance. */
const dialogSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({ open: new Signal<boolean>(false) })),
);

/** The signals the dialog's parts expose. */
type DialogExposed = InstanceSignals<{ open: Signal<boolean> }>;

/** Props for the dialog's `Open` and `Close` buttons. */
type DialogButtonProps = { children?: unknown; label?: string };

/** Props for the dialog's `Panel`. */
type PanelProps = {
  /** Names the dialog to assistive technology. */
  label?: string;
  /** Whether the page stays usable while it is open. Default false. */
  modeless?: boolean;
  /** Opens it as the page loads. */
  open?: boolean;
  /** Its id, for the page's own `commandfor` buttons to open it. */
  id?: string;
  /** Puts its content back as rendered whenever it closes. */
  restoreOnClose?: boolean;
  children?: unknown;
};

/** Props for `Confirm`. */
type ConfirmProps = {
  /** The question asked. */
  message: string;
  /** The yes button's text; by default "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** The submit button to ask before, with the page's own attributes. */
  children?: unknown;
};

/** A panel keeping its rendered content, to put back when it closes. */
type RestorableDialog = HTMLDialogElement & { initialContent?: Node[] };

const dialogHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(dialogSignals);
  return {
    /** Opens a panel rendered `open`, and takes its state. */
    adoptDialog: function (this: HTMLDialogElement) {
      if (this.hasAttribute("data-restore-on-close")) {
        // Copied before anything is typed, as a clone keeps an input's value.
        (this as RestorableDialog).initialContent ??= [...this.childNodes]
          .map((node) => node.cloneNode(true));
      }
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
    /**
     * Notes a close however it came about: Escape, a form, `Close`. A panel
     * restored on close gets its rendered content back.
     */
    dialogClosed: function (this: HTMLDialogElement) {
      signal.open.forInstance(this).value = false;
      const { initialContent } = this as RestorableDialog;
      if (initialContent) {
        this.replaceChildren(
          ...initialContent.map((node) => node.cloneNode(true)),
        );
      }
    },
    /** Notes an open by something other than `Open`, such as an invoker. */
    dialogToggled: function (this: HTMLDialogElement, event: Event) {
      if ((event as ToggleEvent).newState === "open") {
        signal.open.forInstance(this).value = true;
      }
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
    border: 1px solid var(--dialog-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    border-radius: 8px;
    background: var(--dialog-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
    color: var(--dialog-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    box-shadow: 0 12px 32px oklch(21% 0.032 264.7 / 0.2);

    &::backdrop {
      background: var(--dialog-backdrop, oklch(21% 0.032 264.7 / 0.45));
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
export const DialogSignalComponent: SignalComponent<{
  Open: InstancedComponent<DialogExposed, DialogButtonProps>;
  Panel: InstancedComponent<DialogExposed, PanelProps>;
  Close: InstancedComponent<DialogExposed, DialogButtonProps>;
  Confirm: (props: ConfirmProps) => JSX.Element;
}> = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      dialogSignals,
      dialogHandlers,
      dialogStyles,
    );
    return {
      Open: instanced((props: DialogButtonProps) => (
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
      Panel: instanced((props: PanelProps) => (
        <dialog
          id={props.id}
          class={styled.panel}
          aria-label={props.label}
          data-modal={props.modeless ? undefined : ""}
          data-start-open={props.open ? "" : undefined}
          data-restore-on-close={props.restoreOnClose ? "" : undefined}
          onConnect={[signal.open, fn.adoptDialog]}
          onSignal={fn.showDialog}
          onToggle={fn.dialogToggled}
          onClose={fn.dialogClosed}
          onClick={fn.closeOnBackdrop}
          onSubmit={fn.closeOnSubmit}
        >
          {props.children}
        </dialog>
      ), [signal.open]),
      Close: instanced(
        (props: DialogButtonProps) => (
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
      Confirm: transparent((props: ConfirmProps) => (
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
