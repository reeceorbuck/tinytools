/**
 * Local Routes client script for @tinytools/hono-tools
 *
 * Processes local suspense templates using URL pattern matching.
 */

import { processIncomingHtml } from "./processIncomingHtml.ts";
import {
  getCachedRouteTemplate,
  getOrderedLocalRouteTemplates,
  isEmptyRuntimeTemplate,
  isRuntimeCachedRouteTemplate,
  markLocalTemplateContent,
  SPA_REDIRECT_ATTR,
} from "./routeCache.ts";

type QueryCondition = {
  key: string;
  op: "eq" | "neq" | "exists" | "notExists" | "empty";
  value?: string;
};

type ParsedQueryPattern = {
  conditions: QueryCondition[];
  logic: "and" | "or";
};

/**
 * Parses a query pattern string into an array of query conditions.
 * Supports:
 * - `key=value` - exact match
 * - `key=undefined` or `key=null` - param must NOT be present
 * - `key=*` - param must exist (any value)
 * - `key!=value` - param must not equal value
 * - Empty string or `none` - URL must have no query params at all
 * - `&` - AND logic (all conditions must match)
 * - `|` - OR logic (any condition must match)
 */
function parseQueryPattern(queryPattern: string): ParsedQueryPattern {
  const trimmed = queryPattern.trim();

  // Special case: empty pattern or "none" means no query params allowed
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return {
      conditions: [{ key: "", op: "empty" as const }],
      logic: "and",
    };
  }

  // Determine logic type: OR (|) takes precedence if present
  const hasOr = trimmed.includes("|");
  const logic = hasOr ? "or" : "and";
  const separator = hasOr ? "|" : "&";

  const conditions = trimmed.split(separator).map((part) => {
    const partTrimmed = part.trim();

    // Check for != operator first
    if (partTrimmed.includes("!=")) {
      const [key, value] = partTrimmed.split("!=");
      return { key: key.trim(), op: "neq" as const, value: value.trim() };
    }

    const [key, value] = partTrimmed.split("=");
    const trimmedKey = key.trim();
    const trimmedValue = value?.trim();

    if (trimmedValue === "undefined" || trimmedValue === "null") {
      return { key: trimmedKey, op: "notExists" as const };
    }
    if (trimmedValue === "*") {
      return { key: trimmedKey, op: "exists" as const };
    }
    return { key: trimmedKey, op: "eq" as const, value: trimmedValue };
  });

  return { conditions, logic };
}

/**
 * Checks if a single condition matches the URL's query params.
 */
function checkCondition(
  queryParams: URLSearchParams,
  condition: QueryCondition,
): boolean {
  // Special case: URL must have no query params
  if (condition.op === "empty") {
    return queryParams.size === 0;
  }

  const actualValue = queryParams.get(condition.key);
  const exists = queryParams.has(condition.key);

  switch (condition.op) {
    case "eq":
      return actualValue === condition.value;
    case "neq":
      return actualValue !== condition.value;
    case "exists":
      return exists;
    case "notExists":
      return !exists;
  }
}

/**
 * Checks if the URL's query params match the specified conditions.
 */
function matchesQueryPattern(
  queryParams: URLSearchParams,
  parsed: ParsedQueryPattern,
): boolean {
  if (parsed.logic === "or") {
    // OR logic: at least one condition must match
    return parsed.conditions.some((c) => checkCondition(queryParams, c));
  }

  // AND logic: all conditions must match
  return parsed.conditions.every((c) => checkCondition(queryParams, c));
}

export function processLocalSuspenseTemplates(
  destinationUrl: URL,
  formData: FormData | null,
  currentPathname?: string,
  requestMethod = formData ? "post" : "get",
  options: {
    allowRuntimeCache?: boolean;
  } = {},
) {
  const method = requestMethod.toLowerCase();
  const allowRuntimeCache = options.allowRuntimeCache ?? true;
  let block = false;

  const targetPathname = destinationUrl.pathname;
  console.log(
    "Processing local suspense templates for pathname:",
    targetPathname,
  );
  const templates = getOrderedLocalRouteTemplates();
  for (const template of templates) {
    if (isRuntimeCachedRouteTemplate(template) && !allowRuntimeCache) {
      continue;
    }

    const rawPattern = template.getAttribute("path");
    if (!rawPattern) continue;
    const rawMethod = template.getAttribute("method") || "get";
    if (rawMethod !== method) continue;
    console.log("Matched method: ", rawMethod);

    // Check pathname pattern
    const urlPattern = new URLPattern({ pathname: rawPattern });
    const execResult = urlPattern.exec({ pathname: targetPathname });

    if (!execResult) continue; // pathname not a match

    console.log("Found path match with template:", template);
    // Check query pattern if specified
    const queryPattern = template.getAttribute("query");
    if (queryPattern) {
      const conditions = parseQueryPattern(queryPattern);
      if (!matchesQueryPattern(destinationUrl.searchParams, conditions)) {
        console.log("Query pattern not matched:", queryPattern);
        continue; // query params not a match
      }
    }
    console.log("Query pattern matched");
    let templateToRender = template;
    const redirectTo = template.getAttribute(SPA_REDIRECT_ATTR);
    const redirectPathname = redirectTo
      ? new URL(redirectTo, destinationUrl.href).pathname
      : undefined;
    if (redirectTo) {
      const redirectedTemplate = redirectPathname
        ? getCachedRouteTemplate(redirectPathname)
        : null;
      if (
        allowRuntimeCache &&
        redirectedTemplate &&
        isRuntimeCachedRouteTemplate(redirectedTemplate) &&
        redirectedTemplate.content.childElementCount > 0
      ) {
        console.log(
          "Using canonical runtime template via redirect alias:",
          redirectPathname,
        );
        templateToRender = redirectedTemplate;
      }
    }

    const isRuntimeTemplate = isRuntimeCachedRouteTemplate(templateToRender);
    if (isRuntimeTemplate && isEmptyRuntimeTemplate(templateToRender)) {
      console.log(
        "Skipping empty runtime template for active route:",
        targetPathname,
      );
      continue;
    }
    const blockNav = templateToRender.hasAttribute("data-nav-block");
    const cacheCurrentPath = method === "get" ? currentPathname : undefined;
    const pathParams = execResult.pathname.groups as Record<string, string>;
    const queryParams = destinationUrl.searchParams;
    const params: Record<string, string> = {
      ...pathParams,
      ...Object.fromEntries(queryParams.entries()),
      ...formData
        ? Object.fromEntries(
          Array.from(formData.entries()).map((
            [key, value],
          ) => [key, value.toString()]),
        )
        : {},
    };
    console.log("Processing LOCAL route for path with params:", params);
    console.log("using template:", templateToRender);

    const fragment = document.createDocumentFragment();

    const content = templateToRender.content.cloneNode(true);
    console.log("Original template content:", templateToRender.content);
    console.log("Cloned template content:", content);

    const cloneWalker = document.createTreeWalker(
      content,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      null,
    );
    let node: Node | null = cloneWalker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) {
          let text = node.textContent;
          for (const [key, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\$\\[${key}\\]`, "g"), value);
          }
          node.textContent = text;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.hasAttributes()) {
          for (const attr of Array.from(el.attributes)) {
            if (typeof attr.value === "string" && attr.value.includes("$[")) {
              let newVal = attr.value;
              for (const [key, value] of Object.entries(params)) {
                newVal = newVal.replace(
                  new RegExp(`\\$\\[${key}\\]`, "g"),
                  value,
                );
              }
              if (newVal !== attr.value) {
                el.setAttribute(attr.name, newVal);
              }
            }
          }
        }
      }
      node = cloneWalker.nextNode();
    }
    fragment.appendChild(content);
    markLocalTemplateContent(
      fragment,
      isRuntimeTemplate ? "runtime" : "authored",
    );
    processIncomingHtml(fragment, document, {
      cacheCurrentPath,
      activeRouteRegistrations: method === "get" && targetPathname
        ? [
          {
            pathname: targetPathname,
            redirectTo: redirectTo ?? undefined,
          },
          redirectPathname && redirectPathname !== targetPathname
            ? {
              pathname: redirectPathname,
            }
            : null,
        ].filter((entry): entry is { pathname: string; redirectTo?: string } =>
          entry !== null
        )
        : undefined,
      activeRoutePath: method === "get"
        ? (redirectPathname || targetPathname)
        : undefined,
    });

    if (redirectTo) {
      const redirectUrl = new URL(redirectTo, destinationUrl.href);
      const destinationPathWithSearch = destinationUrl.pathname +
        destinationUrl.search + destinationUrl.hash;
      const redirectPathWithSearch = redirectUrl.pathname + redirectUrl.search +
        redirectUrl.hash;

      if (redirectPathWithSearch !== destinationPathWithSearch) {
        console.log(
          "Applying cached route redirect from runtime template:",
          redirectPathWithSearch,
        );
        globalThis.navigation.navigate(redirectPathWithSearch, {
          history: "replace",
          info: {
            onlyUpdateUrl: true,
          },
        });
      }
    }

    if (blockNav) {
      console.warn("Blocking navigation for this local route.");
      block = true;
    }

    // First match wins — stop processing further templates
    break;
  }
  return block;
}
