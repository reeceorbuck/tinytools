import { Handlers } from "../clientTools.ts";

export const clientRouteTools = new Handlers(import.meta.url, {
  compileClientRoute: function (
    path: string,
    query: string | null,
  ): ((url: URL) => Record<string, string | undefined> | null) | null {
    let pattern: URLPattern;
    try {
      pattern = new URLPattern({ pathname: path });
    } catch {
      return null;
    }

    const decode = (value: string) =>
      new URLSearchParams(`value=${value}`).get("value")!;
    const emptyQuery = query !== null &&
      (query.trim() === "" || query.trim().toLowerCase() === "none");
    const alternatives: ((params: URLSearchParams) => boolean)[][] = [];
    if (query !== null && !emptyQuery) {
      for (const alternative of query.split("|")) {
        const conditions: ((params: URLSearchParams) => boolean)[] = [];
        for (const condition of alternative.split("&")) {
          const match = /^([^!=&|]+?)(!=|=)(.*)$/.exec(condition.trim());
          if (!match || !match[1].trim()) return null;
          const key = decode(match[1].trim());
          const operator = match[2];
          const rawValue = match[3].trim();
          const value = decode(rawValue);
          conditions.push(
            operator === "!="
              ? (params) => params.get(key) !== value
              : rawValue === "*"
              ? (params) => params.has(key)
              : rawValue === "null" || rawValue === "undefined"
              ? (params) => !params.has(key)
              : (params) => params.get(key) === value,
          );
        }
        alternatives.push(conditions);
      }
    }

    return (url) => {
      const result = pattern.exec({ pathname: url.pathname });
      if (!result) return null;
      if (emptyQuery && url.searchParams.size !== 0) return null;
      if (
        alternatives.length &&
        !alternatives.some((conditions) =>
          conditions.every((condition) => condition(url.searchParams))
        )
      ) return null;
      return result.pathname.groups;
    };
  },
  interpolateClientRouteValue: function (
    value: string,
    params: Readonly<Record<string, string | undefined>>,
  ): string {
    return value.replace(
      /\$\[([^\]]+)\]/g,
      (_placeholder, key: string) =>
        Object.hasOwn(params, key) ? params[key] ?? "" : "",
    );
  },
  cloneClientRoute: function (
    route: Element,
    params: Readonly<Record<string, string | undefined>>,
  ): DocumentFragment {
    const insertion = route.hasAttribute("from-partial-id")
      ? route.querySelector<HTMLTemplateElement>("template[for-partial-id]")
      : null;
    const cachedContent = document.createDocumentFragment();
    if (insertion) {
      cachedContent.append(...Array.from(insertion.content.childNodes));
    }
    const fragment = document.createDocumentFragment();
    for (const child of route.childNodes) {
      fragment.appendChild(child.cloneNode(true));
    }
    const interpolateContent = (content: DocumentFragment) => {
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.textContent?.includes("$[")) {
            node.textContent = interpolateClientRouteValue(
              node.textContent,
              params,
            );
          }
        } else {
          const element = node as Element;
          for (const attribute of Array.from(element.attributes)) {
            if (attribute.value.includes("$[")) {
              element.setAttribute(
                attribute.name,
                interpolateClientRouteValue(attribute.value, params),
              );
            }
          }
          if (element instanceof HTMLTemplateElement) {
            interpolateContent(element.content);
          }
        }
      }
    };
    if (route.getAttribute("interpolate") !== "false") {
      interpolateContent(fragment);
    }
    if (insertion) {
      fragment.querySelector<HTMLTemplateElement>("template[for-partial-id]")!
        .content.append(cachedContent);
    }
    return fragment;
  },
});

export const compileClientRoute =
  clientRouteTools.getFunctionReferences.compileClientRoute;
export const interpolateClientRouteValue =
  clientRouteTools.getFunctionReferences.interpolateClientRouteValue;
export const cloneClientRoute =
  clientRouteTools.getFunctionReferences.cloneClientRoute;
