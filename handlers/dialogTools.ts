import { Handlers } from "../clientTools.ts";

/** Handlers for `<dialog>` elements. */
export const dialogTools: Handlers<{
  /**
   * Safari fallback for `closedby="any"`: closes the dialog on a click
   * outside its box. A click on the backdrop targets the dialog itself.
   * Bind it as the dialog's `onClick`; it does nothing where the browser
   * supports `closedby`. Delete once Safari does.
   */
  closedByAnyFallback(this: HTMLDialogElement, e: MouseEvent): void;
}> = new Handlers(import.meta.url, {
  closedByAnyFallback: function (this: HTMLDialogElement, e: MouseEvent) {
    if ("closedBy" in HTMLDialogElement.prototype || e.target !== this) {
      return;
    }
    const box = this.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right &&
      e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) this.close();
  },
});
