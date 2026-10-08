// Imported by the package's own components, so this avoids the module cycle
// through `mod.ts` that the app-facing handler modules need not worry about.
import { Handlers } from "../clientTools.ts";

/** Bundles register their handlers here as they evaluate (see `runHandler`). */
type RegisteredBundles = Record<string, Record<string, unknown>>;

/**
 * Clones the `tiny.Templates` entry named by `reference` (`<bundle>.<name>`,
 * a clone's `reference` on the server) and fills its `<slot>`s from the
 * children of `slotted`: a child with `slot="x"` replaces `<slot name="x">`,
 * children without a `slot` attribute replace the unnamed `<slot>`. The
 * bundle is imported if the page has not loaded it yet.
 */
async function cloneTemplate(
  reference: string,
  slotted?: ParentNode,
): Promise<DocumentFragment> {
  const dot = reference.indexOf(".");
  if (dot < 1) throw new Error(`Invalid template reference: ${reference}`);
  const bundle = reference.slice(0, dot);
  const name = reference.slice(dot + 1);
  const module = (globalThis as { handlers?: RegisteredBundles }).handlers
    ?.[bundle] ?? await import(`/handlers/${bundle}.js`);
  const clone = module[name];
  if (typeof clone !== "function") {
    throw new Error(`Template ${reference} not found in its bundle.`);
  }
  const built = clone() as DocumentFragment;
  if (slotted) {
    // Matched by attribute rather than a `:scope >` query, which browsers do
    // not apply consistently to a DocumentFragment.
    const children = Array.from(slotted.children);
    // Each child fills one slot: once placed it is not moved again, even by
    // an unnamed slot after its `slot` attribute has gone.
    const placed = new Set<Element>();
    for (const slot of Array.from(built.querySelectorAll("slot"))) {
      const slotName = slot.getAttribute("name");
      const fill = children.filter((child) =>
        !placed.has(child) &&
        (slotName
          ? child.getAttribute("slot") === slotName
          : !child.hasAttribute("slot"))
      );
      for (const element of fill) {
        placed.add(element);
        element.removeAttribute("slot");
      }
      slot.replaceWith(...fill);
    }
  }
  return built;
}

/** Cloning `tiny.Templates` entries in the browser, and `BuildFromTemplate`'s handler. */
export const templateTools = new Handlers(import.meta.url, {
  cloneTemplate,
  /**
   * Replaces this `<template>` with the clone its `data-template` names,
   * filled from the template's own content. Bound to `onParsed`, so it runs
   * once the content has been parsed and never again.
   */
  buildFromTemplate: async function (this: HTMLTemplateElement) {
    const built = await cloneTemplate(
      this.dataset.template ?? "",
      this.content,
    );
    this.replaceWith(built);
  },
});
