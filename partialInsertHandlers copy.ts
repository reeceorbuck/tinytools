import { Handlers } from "./clientTools.ts";

export const partialInsertHandlers = new Handlers(import.meta.url, {
  partialReplace: function (this: HTMLTemplateElement) {
    const existing = document.getElementById(this.id);
    if (existing) {
      existing.replaceChildren(...Array.from(this.content.childNodes));
    } else {
      console.error(`No existing element found for partial "${this.id}".`);
    }
    this.remove();
  },

  partialBlast: function (this: HTMLTemplateElement) {
    const existing = document.getElementById(this.id);
    if (existing) {
      existing.replaceWith(...Array.from(this.content.childNodes));
    } else {
      console.error(`No existing element found for partial "${this.id}".`);
    }
    this.remove();
  },
});
