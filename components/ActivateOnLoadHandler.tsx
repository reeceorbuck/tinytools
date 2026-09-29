export interface PartialAbortableHTMLElement extends HTMLElement {
  abortController: AbortController;
}

import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { tiny } from "../mod.ts";
import { Handlers } from "../clientTools.ts";

const lifecycleHandlers = new Handlers(import.meta.url, {
  referOnLoadOnce: function (this: HTMLElement, e: Event) {
    console.log("referOnLoadOnce", e);
    const target = this.previousSibling;
    if (target instanceof Element) {
      target.dispatchEvent(new Event("load"));
    }
    this.remove();
  },
  referOnLoad: function (this: HTMLElement, e: Event) {
    console.log("NEW referOnLoad", e);
    const target = this.previousSibling?.firstChild;
    if (target instanceof Element) {
      target.dispatchEvent(new Event("load"));
    }
  },
  referOnSuspend: function (this: HTMLElement, e: Event) {
    console.log("NEW referOnSuspend", e);
    const target = this.firstChild;
    if (target instanceof Element) {
      target.dispatchEvent(new Event("suspend"));
    }
  },
  referOnConnect: function (this: HTMLElement) {
    this.firstElementChild?.dispatchEvent(new Event("load"));
  },
});

export async function ActivateOnLoadHandler(
  { children }: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(lifecycleHandlers);
  const childElements = Array.isArray(children) ? children.flat() : [children];

  return (
    <>
      {childElements.map((child) => (
        <>
          {child}
          <img
            hidden
            src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
            onLoad={fn.referOnLoadOnce}
          />
        </>
      ))}
    </>
  );
}

export async function ActivateLifecycleHandlers(
  { children }: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(lifecycleHandlers);
  const childElements = Array.isArray(children) ? children.flat() : [children];

  return (
    <>
      {childElements.map((child) => (
        <>
          <abortable-lifecycle-element
            onLoad={fn.referOnConnect}
            onSuspend={fn.referOnSuspend}
          >
            {child}
          </abortable-lifecycle-element>
          <link
            rel="modulepreload"
            href={`/handlers/${
              lifecycleHandlers._handlerFilenames.get("referOnLoad")
            }.js`}
            onLoad={fn.referOnLoad}
          />
        </>
      ))}
    </>
  );
}

export async function BuildFromTemplateElement(
  { children, templateId }: PropsWithChildren<{ templateId: string }>,
) {
  const { fn } = await tiny.imports(lifecycleHandlers, buildTemplateHandlers);
  return (
    <ActivateOnLoadHandler>
      <temp-element
        onLoad={fn.buildTemplate}
        data-template={templateId}
      >
        <template>
          {children}
        </template>
      </temp-element>
    </ActivateOnLoadHandler>
  );
}

export const buildTemplateHandlers = new Handlers(import.meta.url, {
  buildTemplate: function (this: HTMLElement, _e: Event) {
    const templateId = this.dataset.template;
    if (!templateId) {
      console.error("Template ID not found!");
      return;
    }

    const template = document.getElementById(templateId) as
      | HTMLTemplateElement
      | null;

    if (!template) {
      console.error("Template not found!");
      return;
    }
    console.log("AAA Template: ", template);

    const templateClone = template.content.cloneNode(
      true,
    ) as DocumentFragment;

    const childTemplate = this.querySelector("template");
    const insertContent = childTemplate?.content.cloneNode(true) as
      | DocumentFragment
      | null;

    console.log("Insert content: ", insertContent?.cloneNode(true));
    const slotChildren = Array.from(insertContent?.children ?? []).filter(
      (child) => child.hasAttribute("slot"),
    );
    console.log("Slot children: ", slotChildren);
    slotChildren?.forEach((slotChild) => {
      const slotName = slotChild.getAttribute("slot");
      if (!slotName) {
        console.error("Slot name not found: ", slotChild);
        return;
      }
      const slotElement = templateClone.querySelector(
        `slot[name="${slotName}"]`,
      );
      if (!slotElement) {
        console.error("Slot element not found: ", slotName);
        console.log("templateClone: ", templateClone);
        return;
      }
      const inputClone = slotChild.cloneNode(true) as HTMLElement;
      inputClone.removeAttribute("slot");
      slotElement.insertAdjacentElement("beforebegin", inputClone);
      slotChild.remove();
    });
    console.log("Appending template clone: ", templateClone.cloneNode(true));
    this.appendChild(templateClone);
    childTemplate?.remove();
  },
  loadTextArea: function (this: HTMLElement, _e: Event) {
    const replaceElement = this.parentElement;
    if (!replaceElement) {
      console.error("No parent element found");
      return;
    }
    console.log("loadTextArea activated, replaceElement: ", replaceElement);
    const textarea = document.createElement("textarea");
    Array.from(replaceElement.attributes).forEach((attr) => {
      textarea.setAttribute(attr.name, attr.value);
    });
    textarea.value = new DOMParser().parseFromString(
      replaceElement.textContent,
      "text/html",
    ).body.textContent;
    console.log("textarea value: ", textarea.value);
    replaceElement.setAttribute("replaced", "true");
    replaceElement.replaceWith(textarea);
  },
});

const partialLogic = new Handlers(import.meta.url, {
  passLoadEvent: function (this: HTMLElement) {
    const precedingTemplate = this.previousElementSibling;
    if (precedingTemplate && precedingTemplate.tagName === "TEMPLATE") {
      precedingTemplate.dispatchEvent(new Event("load"));
      this.remove();
    } else {
      console.error(
        "No preceding template found for loadPartialTemplate handler.",
      );
    }
  },
});

// export async function ReferLifecycleEventsOntoParentElement() {
//   const { fn } = await tiny.imports(partialLogic);
//   return (
//     <abortable-lifecycle-element
//       onLoad={fn.referToPrecedingOnConnect}
//       onSuspend={fn.referToPrecedingOnSuspend}
//     >
//     </abortable-lifecycle-element>
//   );
// }

const upgradePrecedingTools = new Handlers(import.meta.url, {
  upgradePrecedingCustomElement: function (this: HTMLElement) {
    const precedingCustomElement = this.previousElementSibling as
      | HTMLElement
      | null;
    console.log("UPGRADING precedingCustomElement: ", precedingCustomElement);

    if (!precedingCustomElement) {
      console.error("No preceding custom element found");
      return;
    }

    let upgradeTagName = precedingCustomElement.tagName.toLowerCase();
    if (!upgradeTagName.includes("-")) {
      upgradeTagName = "upgrade-preceding";
      const proxyElement = document.createElement(
        upgradeTagName,
      ) as PartialAbortableHTMLElement;
      proxyElement.addEventListener("load", function () {
        tiny.runHandler(
          precedingCustomElement,
          new Event("load"),
        );
        // Mutation observer if the previous element is replaced?
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === "childList") {
              for (const removedNode of Array.from(mutation.removedNodes)) {
                if (removedNode === precedingCustomElement) {
                  // Remove the new element if the preceding custom element is removed
                  proxyElement.remove();
                }
              }
            }
          }
        });

        observer.observe(precedingCustomElement.parentElement!, {
          childList: true,
        });
        proxyElement.addEventListener("load", () => {
          tiny.runHandler(
            precedingCustomElement,
            new Event("load"),
          );
          observer.observe(precedingCustomElement.parentElement!, {
            childList: true,
          });
        }, { signal: proxyElement.abortController.signal });
        proxyElement.addEventListener("suspend", () => {
          tiny.runHandler(
            precedingCustomElement,
            new Event("suspend"),
          );
          // stop observing when the element is disconnected
          observer.disconnect();
        }, { signal: proxyElement.abortController.signal });
      }, { once: true });
      precedingCustomElement.insertAdjacentElement("afterend", proxyElement);
    }

    const isDefined = customElements.get(
      upgradeTagName,
    );
    if (!isDefined) {
      // register it
      customElements.define(
        upgradeTagName,
        class extends HTMLElement {
          abortController: AbortController;

          constructor() {
            super();
            this.abortController = new AbortController();
          }

          connectedCallback() {
            this.abortController = new AbortController();
            this.dispatchEvent(new Event("load"));
            try {
              tiny.runHandler(
                this,
                new Event("connect"),
              );
            } catch (error) {
              // May just be because there is no listener for this event
              console.warn(
                "Error during connect event (no listener?):",
                error,
              );
            }
          }

          disconnectedCallback() {
            // this next one should allow for custom events on the element
            try {
              tiny.runHandler(
                this,
                new Event("disconnect"),
              );
            } catch (error) {
              // May just be because there is no listener for this event
              console.warn(
                "Error during disconnect event (no listener?):",
                error,
              );
            }
            this.abortController.abort();
          }
        },
      );
    }
    this.remove();
  },
  testSuspension: function (this: HTMLElement) {
    console.log("testSuspension activated for element: ", this);
  },
});

export async function UpgradeCustomElement(props: PropsWithChildren) {
  const { fn } = await tiny.imports(upgradePrecedingTools, lifecycleHandlers);
  const childElements = Array.isArray(props.children)
    ? props.children.flat()
    : [props.children];
  return (
    <>
      {childElements.map((child) => (
        <>
          {child}
          <link
            rel="modulepreload"
            href={`/handlers/${
              lifecycleHandlers._handlerFilenames.get(
                "referOnLoad",
              )
            }.js`}
            onLoad={fn.upgradePrecedingCustomElement}
          />
        </>
      ))}
    </>
  );
}

const usageExampleComponent = async () => {
  const { fn } = await tiny.imports(upgradePrecedingTools);
  return (
    <UpgradeCustomElement>
      <upgradeable-element
        onLoad={fn.upgradePrecedingCustomElement}
        onDisconnect={fn.testSuspension}
      >
        <h1>Hello World</h1>
      </upgradeable-element>
    </UpgradeCustomElement>
  );
};
