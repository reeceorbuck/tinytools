/**
 * Local Routes client script for @tiny-tools/hono
 *
 * Processes local suspense templates using URL pattern matching.
 */

import { processIncomingHtml } from "./processIncomingHtml.ts";

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
) {
  const method = formData ? "post" : "get";
  let block = false;

  const noParamHref = destinationUrl.origin + destinationUrl.pathname;
  console.log(
    "Processing local suspense templates for noParamHref URL:",
    noParamHref,
  );
  const templates = document.querySelectorAll<HTMLTemplateElement>(
    "template[path]",
  );
  for (const template of templates) {
    const rawPattern = template.getAttribute("path");
    if (!rawPattern) continue;
    const rawMethod = template.getAttribute("method") || "get";
    if (rawMethod !== method) continue;
    console.log("Matched method: ", rawMethod);

    // Check pathname pattern
    const urlPattern = new URLPattern({ pathname: rawPattern });
    const execResult = urlPattern.exec(noParamHref);

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
    console.log("Processing LOCAL route for path:", params);
    console.log("using template:", template);

    const fragment = document.createDocumentFragment();

    const content = template.content.cloneNode(true);
    console.log("Original template content:", template.content);
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
    processIncomingHtml(fragment);

    const blockNav = template.hasAttribute("data-nav-block");
    if (blockNav) {
      console.warn("Blocking navigation for this local route.");
      block = true;
    }

    // First match wins — stop processing further templates
    break;
  }
  return block;
}
