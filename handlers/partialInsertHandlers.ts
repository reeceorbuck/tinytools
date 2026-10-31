import { Handlers } from "../clientTools.ts";

/**
 * A partial's template. With an `optional-target` attribute (set on partials
 * pushed from the server, which may target content the page doesn't show) a
 * missing target is skipped silently. `updateRoot` is set when the partial is applied to
 * cached content rather than the live document.
 */
type PartialTemplate = HTMLTemplateElement & {
  updateRoot?: DocumentFragment;
};

/**
 * Insertion handlers that apply a partial's template to the element whose id
 * is in its `for-partial-id`, then remove the template. Pass one as the
 * `onLoad` of a `NewPartial`; `PartialReplace` and `PartialDelete` pick theirs
 * for you.
 */
export const partialInsertHandlers: Handlers<{
  /** Replaces the target's children with the template's content. */
  partialReplace(this: PartialTemplate): void;
  /** Replaces the target itself with the template's content. */
  partialBlast(this: PartialTemplate): void;
  /**
   * Merges each child of the template into the target, matching an existing
   * child by `id` (or `match-id`) and then by `group-name`. The `existing`
   * and `group` attributes say what to do with a match, `new` what to do
   * with an unmatched child, and `insert-before` where to place it.
   */
  partialMergeContent(this: PartialTemplate): void;
  /** Removes the target from the page. */
  partialDelete(this: PartialTemplate): void;
}> = new Handlers(import.meta.url, {
  partialReplace: function (this: PartialTemplate) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = (this.updateRoot ?? document).getElementById(partialId);
    if (existing && existing !== this) {
      existing.replaceChildren(...Array.from(this.content.childNodes));
    } else if (!this.hasAttribute("optional-target")) {
      console.error(`No existing element found for partial-id "${partialId}".`);
    }
    this.remove();
  },

  partialBlast: function (this: PartialTemplate) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = (this.updateRoot ?? document).getElementById(partialId);
    if (existing && existing !== this) {
      existing.replaceWith(...Array.from(this.content.childNodes));
    } else if (!this.hasAttribute("optional-target")) {
      console.error(`No existing element found for partial-id "${partialId}".`);
    }
    this.remove();
  },

  partialMergeContent: function (this: PartialTemplate) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = (this.updateRoot ?? document).getElementById(partialId);
    if (!existing || existing === this) {
      if (!this.hasAttribute("optional-target")) {
        console.error(
          `No existing element found for partial-id "${partialId}".`,
        );
      }
      // this.remove();
      return;
    }

    const groupName = this.getAttribute("group-name");
    // `insert-before`: space-separated ids of the children that should follow
    // the inserted content, nearest first. The first one present is the
    // anchor; without one, content is placed by the `new` mode. Existing
    // matches are moved to the anchor too, keeping a sorted list in order.
    const insertBefore = this.getAttribute("insert-before");
    const anchorIds = insertBefore?.split(" ").filter(Boolean) ?? [];
    const anchor = anchorIds
      .map((id) =>
        Array.from(existing.children).find((child) => child.id === id)
      )
      .find((child) => child !== undefined);

    Array.from(this.content.children).forEach((insertNode) => {
      const searchId = insertNode.getAttribute("match-id") || insertNode.id;
      insertNode.removeAttribute("match-id");
      groupName && insertNode.setAttribute("data-partial-group", groupName);
      let existingChild = searchId
        ? existing.children.namedItem(searchId)
        : undefined;

      let existingMode = this.getAttribute("existing");
      if (!existingChild) {
        existingMode = this.getAttribute("group");
        existingChild = groupName
          ? Array.from(existing.children).find((child) =>
            child.getAttribute("data-partial-group") === groupName
          )
          : undefined;
      }

      if (existingChild) {
        switch (existingMode) {
          case "substitute":
            if (insertBefore !== null) {
              existingChild.remove();
              if (anchor) anchor.before(insertNode);
              else existing.append(insertNode);
            } else {
              existingChild.replaceWith(insertNode);
            }
            break;
          case "match":
            break;
          case "substitute(append)":
            existingChild.remove();
          // falls through
          case "match(append)":
            existing.append(insertNode);
            break;
          case "substitute(prepend)":
            existingChild.remove();
          // falls through
          case "match(prepend)":
            existing.prepend(insertNode);
            break;
          default:
            console.error("Unexpected existing mode:", existingMode);
            break;
        }
        return;
      }

      const newMode = this.getAttribute("new");
      if (anchor && newMode !== "ignore") {
        anchor.before(insertNode);
        return;
      }
      switch (newMode) {
        case "append":
          existing.append(insertNode);
          break;
        case "prepend":
          existing.prepend(insertNode);
          break;
        case "ignore":
          break;
        default:
          console.error("Unexpected new mode:", insertNode);
          break;
      }
    });
    this.remove();
  },

  partialDelete: function (this: PartialTemplate) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = (this.updateRoot ?? document).getElementById(partialId);
    if (!existing || existing === this) {
      if (!this.hasAttribute("optional-target")) {
        console.error(
          `No existing element found for partial-id "${partialId}".`,
        );
      }
      this.remove();
      return;
    }
    existing.remove();
    this.remove();
  },
});
