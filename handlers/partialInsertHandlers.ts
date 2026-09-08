import { Handlers } from "../clientTools.ts";

export const partialInsertHandlers = new Handlers(import.meta.url, {
  partialReplace: function (this: HTMLTemplateElement) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = document.getElementById(partialId);
    if (existing && existing !== this) {
      existing.replaceChildren(...Array.from(this.content.childNodes));
    } else {
      console.error(`No existing element found for partial-id "${partialId}".`);
    }
    this.remove();
  },

  partialBlast: function (this: HTMLTemplateElement) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = document.getElementById(partialId);
    if (existing && existing !== this) {
      existing.replaceWith(...Array.from(this.content.childNodes));
    } else {
      console.error(`No existing element found for partial-id "${partialId}".`);
    }
    this.remove();
  },

  partialMergeContent: function (this: HTMLTemplateElement) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = document.getElementById(partialId);
    if (!existing || existing === this) {
      console.error(`No existing element found for partial-id "${partialId}".`);
      // this.remove();
      return;
    }

    const groupName = this.getAttribute("group-name");

    Array.from(this.children).forEach((insertNode) => {
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
            if (insertNode.tagName === "PARTIAL-CONTENT") {
              // const contexts = (globalThis as typeof globalThis & {
              //   [key: symbol]: WeakMap<Element, unknown>;
              // })[Symbol.for("tinytools.partialContentContexts")];
              // contexts?.set(insertNode, {
              //   ...(this.partialContext ?? {
              //     options: {},
              //     incomingElements: [insertNode],
              //     state: new Set<string>(),
              //   }),
              //   scope: existingChild.parentElement!,
              // });
              // document.body.appendChild(insertNode);
              console.warn(
                "Partial-content is not implemented yet in partial-merge-content!",
              );
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

  partialDelete: function (this: HTMLTemplateElement) {
    const partialId = this.getAttribute("for-partial-id");
    if (!partialId) {
      console.error(`No partial id found for partial "${this.id}".`);
      return;
    }
    const existing = document.getElementById(partialId);
    if (!existing || existing === this) {
      console.error(`No existing element found for partial-id "${partialId}".`);
      this.remove();
      return;
    }
    existing.remove();
    this.remove();
  },
});
