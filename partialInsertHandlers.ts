import { Handlers } from "./clientTools.ts";
import type { PartialContentElement } from "./client/wc-partialContent.ts";

export const partialInsertHandlers = new Handlers(import.meta.url, {
  partialRouteCache: function (this: PartialContentElement) {
    const context = this.partialContext;
    if (!context || context.options.bypassRouteCache) return true;
    if (context.state.has("route-cache:stale")) {
      this.remove();
      return false;
    }
    if (context.state.has("route-cache:processed")) return true;
    context.state.add("route-cache:processed");

    const cacheIdAttribute = "data-cache-id";
    const localTemplateSourceAttribute = "data-tinytools-local-template-source";
    const routeCacheAttribute = "data-tinytools-route-cache";
    const redirectAttribute = "data-spa-redirect";
    const activePathAttribute = "data-tinytools-active-route-cache-path";
    const captureAttribute = "data-tinytools-cache-capture";
    const normalizePath = (pathname: string) =>
      pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
    const createCacheId = () =>
      typeof crypto.randomUUID === "function"
        ? `ttc-${crypto.randomUUID()}`
        : `ttc-${Date.now().toString(36)}-${
          Math.random().toString(36).slice(2, 8)
        }`;
    const ensureCacheId = (element: Element, preferred?: string) => {
      const current = element.getAttribute(cacheIdAttribute);
      if (current) return current;
      const cacheId = preferred ?? createCacheId();
      element.setAttribute(cacheIdAttribute, cacheId);
      return cacheId;
    };
    const findById = (scope: ParentNode, id: string) =>
      Array.from(scope.querySelectorAll(`#${CSS.escape(id)}`)).find((element) =>
        element !== this && !this.contains(element)
      ) ?? null;
    const cacheContainer = () => {
      const current = document.querySelector<HTMLElement>(
        "route-cache[data-dynamic]",
      );
      if (current) return current;
      const container = document.createElement("route-cache");
      container.setAttribute("data-dynamic", "");
      container.hidden = true;
      (document.body ?? document.documentElement).appendChild(container);
      return container;
    };
    const clearTemplate = (template: HTMLTemplateElement) => {
      template.content.replaceChildren();
    };
    const adoptTemplate = (template: HTMLTemplateElement) => {
      const parent = template.parentElement;
      cacheContainer().prepend(template);
      if (
        parent?.tagName === "ROUTE-CACHE-SEED" &&
        parent.children.length === 0
      ) {
        parent.remove();
      }
    };
    const getTemplate = (pathname: string) => {
      const existing = document.querySelector<HTMLTemplateElement>(
        `template[path="${
          CSS.escape(pathname)
        }"][${routeCacheAttribute}="true"]`,
      );
      if (existing) return existing;
      const template = document.createElement("template");
      template.setAttribute("path", pathname);
      template.setAttribute("method", "get");
      template.setAttribute("data-nav-block", "");
      template.setAttribute(routeCacheAttribute, "true");
      cacheContainer().prepend(template);
      return template;
    };
    const createReference = (element: Element, cacheId: string) => {
      const reference = document.createElement("partial-content");
      reference.id = element.id;
      const mountHandler = element.getAttribute("onmount");
      if (mountHandler) reference.setAttribute("onmount", mountHandler);
      reference.setAttribute(cacheIdAttribute, cacheId);
      reference.setAttribute(localTemplateSourceAttribute, "runtime");
      return reference;
    };
    const trackable = (element: Element) =>
      element.id.length > 0 && !/^suspended-\d+$/i.test(element.id);

    const registrations = context.options.activeRouteRegistrations ??
      (context.options.activeRoutePath
        ? [{ pathname: context.options.activeRoutePath }]
        : []);
    const currentGeneration = Number(
      document.documentElement.getAttribute("data-tinytools-nav-generation") ??
        "0",
    );
    const stale = typeof context.options.navGeneration === "number" &&
      context.options.navGeneration !== currentGeneration;

    if (stale) {
      for (const registration of registrations) {
        const template = getTemplate(registration.pathname);
        if (registration.redirectTo) {
          template.setAttribute(redirectAttribute, registration.redirectTo);
          clearTemplate(template);
          adoptTemplate(template);
          continue;
        }
        clearTemplate(template);
        for (const element of context.incomingElements.filter(trackable)) {
          const cacheId = ensureCacheId(element);
          const reference = createReference(element, cacheId);
          Array.from(element.childNodes).forEach((child) =>
            reference.appendChild(child.cloneNode(true))
          );
          template.content.appendChild(reference);
        }
        adoptTemplate(template);
      }
      context.state.add("route-cache:stale");
      this.remove();
      return false;
    }

    if (context.options.updateCachedTemplates) {
      const templates = Array.from(
        document.querySelectorAll<HTMLTemplateElement>(
          `template[${routeCacheAttribute}="true"]`,
        ),
      );
      for (const template of templates) {
        if (template.hasAttribute(redirectAttribute)) continue;
        for (const incoming of context.incomingElements) {
          if (!incoming.id) continue;
          const reference = findById(template.content, incoming.id);
          if (!reference) continue;
          const cacheId = incoming.getAttribute(cacheIdAttribute) ||
            reference.getAttribute(cacheIdAttribute) ||
            ensureCacheId(reference);
          reference.setAttribute(cacheIdAttribute, cacheId);
          reference.setAttribute(localTemplateSourceAttribute, "runtime");
          reference.replaceChildren(
            ...Array.from(incoming.childNodes).map((child) =>
              child.cloneNode(true)
            ),
          );
        }
      }
    }

    if (context.options.cacheCurrentPath) {
      const outgoingPath = normalizePath(context.options.cacheCurrentPath);
      const templates = document.querySelectorAll<HTMLTemplateElement>(
        `template[${routeCacheAttribute}="true"]`,
      );
      for (const template of templates) {
        const templatePath = normalizePath(template.getAttribute("path") ?? "");
        const redirectTarget = template.getAttribute(redirectAttribute);
        const capturesOutgoing = templatePath === outgoingPath ||
          (redirectTarget != null &&
            normalizePath(redirectTarget.split("?")[0].split("#")[0]) ===
              outgoingPath);
        if (!capturesOutgoing) continue;
        const references = template.content.querySelectorAll<Element>(
          `partial-content[${cacheIdAttribute}]`,
        );
        for (const reference of references) {
          const existing = findById(context.scope, reference.id);
          if (
            !existing ||
            existing.getAttribute(localTemplateSourceAttribute) === "authored"
          ) continue;
          const cacheId = ensureCacheId(
            existing,
            reference.getAttribute(cacheIdAttribute) ?? undefined,
          );
          reference.setAttribute(cacheIdAttribute, cacheId);
          if (!template.hasAttribute(redirectAttribute)) {
            if (reference.getAttribute(captureAttribute) === "element") {
              reference.replaceChildren(existing.cloneNode(true));
            } else {
              reference.replaceChildren(
                ...Array.from(existing.childNodes).map((child) =>
                  child.cloneNode(true)
                ),
              );
            }
          }
        }
        adoptTemplate(template);
      }
    }

    if (context.options.activeRoutePath) {
      document.documentElement.setAttribute(
        activePathAttribute,
        normalizePath(context.options.activeRoutePath),
      );
    }

    for (const registration of registrations) {
      const template = getTemplate(registration.pathname);
      if (registration.redirectTo) {
        template.setAttribute(redirectAttribute, registration.redirectTo);
        clearTemplate(template);
        adoptTemplate(template);
        continue;
      }
      template.removeAttribute(redirectAttribute);
      const incomingElements = context.incomingElements.filter(trackable);
      if (incomingElements.length === 0) {
        adoptTemplate(template);
        continue;
      }
      clearTemplate(template);
      for (const element of incomingElements) {
        const existing = findById(context.scope, element.id);
        const cacheId = element.getAttribute(cacheIdAttribute) ||
          existing?.getAttribute(cacheIdAttribute) || ensureCacheId(element);
        element.setAttribute(cacheIdAttribute, cacheId);
        const reference = createReference(element, cacheId);
        Array.from(element.childNodes).forEach((child) =>
          reference.appendChild(child.cloneNode(true))
        );
        template.content.appendChild(reference);
      }
      adoptTemplate(template);
    }
    return true;
  },

  partialAutofocus: function (this: PartialContentElement) {
    const targets = [
      ...(this.hasAttribute("autofocus") ? [this] : []),
      ...Array.from(this.querySelectorAll<HTMLElement>("[autofocus]")),
    ];
    if (targets.length === 0) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        active && active !== document.body &&
        targets.some((target) => target.contains(active))
      ) return;
      const target = targets.find((candidate) => candidate.isConnected);
      if (!target) return;
      target.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (target.isConnected) {
          target.scrollIntoView({ block: "start", behavior: "auto" });
        }
      });
    });
  },

  partialAttributes: function (this: PartialContentElement) {
    const scope = this.partialContext?.scope ?? document;
    const existing = Array.from(
      scope.querySelectorAll(`#${CSS.escape(this.id)}`),
    )
      .find((element) => element !== this && !this.contains(element));
    if (!existing) {
      console.error(`No existing element found for partial "${this.id}".`);
      this.remove();
      return;
    }
    Array.from(this.attributes).forEach((attribute) => {
      if (
        attribute.name !== "id" && attribute.name !== "name" &&
        attribute.name !== "onmount" && attribute.name !== "mounted"
      ) {
        if (attribute.name === "value") {
          (existing as HTMLInputElement).value = attribute.value;
        } else {
          existing.setAttribute(attribute.name, attribute.value);
        }
      }
    });
    this.remove();
  },

  partialReplace: function (this: PartialContentElement) {
    const scope = this.partialContext?.scope ?? document;
    const existing = Array.from(
      scope.querySelectorAll(`#${CSS.escape(this.id)}`),
    )
      .find((element) => element !== this && !this.contains(element));
    if (!existing) {
      console.error(`No existing element found for partial "${this.id}".`);
      this.remove();
      return;
    }
    existing.replaceChildren(...Array.from(this.childNodes));
    this.remove();
  },

  partialBlast: function (this: PartialContentElement) {
    const scope = this.partialContext?.scope ?? document;
    const cacheId = this.getAttribute("data-cache-id");
    if (cacheId) {
      document.querySelectorAll<HTMLTemplateElement>(
        'template[data-tinytools-route-cache="true"]',
      ).forEach((template) => {
        template.content.querySelectorAll<Element>(
          `partial-content[data-cache-id="${CSS.escape(cacheId)}"]`,
        ).forEach((reference) => {
          reference.setAttribute("data-tinytools-cache-capture", "element");
        });
      });
    }
    const existing = Array.from(
      scope.querySelectorAll(`#${CSS.escape(this.id)}`),
    )
      .find((element) => element !== this && !this.contains(element));
    if (!existing) {
      this.replaceWith(...Array.from(this.children));
      return;
    }
    existing.replaceWith(...Array.from(this.children));
    this.remove();
  },

  partialDelete: function (this: PartialContentElement) {
    const scope = this.partialContext?.scope ?? document;
    const existing = Array.from(
      scope.querySelectorAll(`#${CSS.escape(this.id)}`),
    )
      .find((element) => element !== this && !this.contains(element));
    existing?.remove();
    this.remove();
  },

  partialMergeContent: function (this: PartialContentElement) {
    const scope = this.partialContext?.scope ?? document;
    const existing = Array.from(
      scope.querySelectorAll(`#${CSS.escape(this.id)}`),
    )
      .find((element) => element !== this && !this.contains(element));
    if (!existing) {
      console.error(`No existing element found for partial "${this.id}".`);
      this.remove();
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
              const contexts = (globalThis as typeof globalThis & {
                [key: symbol]: WeakMap<Element, unknown>;
              })[Symbol.for("tinytools.partialContentContexts")];
              contexts?.set(insertNode, {
                ...(this.partialContext ?? {
                  options: {},
                  incomingElements: [insertNode],
                  state: new Set<string>(),
                }),
                scope: existingChild.parentElement!,
              });
              document.body.appendChild(insertNode);
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
});
