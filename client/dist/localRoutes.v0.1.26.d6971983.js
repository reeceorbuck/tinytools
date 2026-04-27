import { processIncomingHtml } from "./processIncomingHtml.v0.1.24.8f204288.js";
import {
  getCachedRouteTemplate,
  getOrderedLocalRouteTemplates,
  isEmptyRuntimeTemplate,
  isRuntimeCachedRouteTemplate,
  markLocalTemplateContent,
  SPA_REDIRECT_ATTR
} from "./routeCache.v0.1.24.4c2b30e3.js";
import { navigation } from "./navigationApi.v0.1.26.2ec47448.js";
function parseQueryPattern(queryPattern) {
  const trimmed = queryPattern.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return {
      conditions: [{ key: "", op: "empty" }],
      logic: "and"
    };
  }
  const hasOr = trimmed.includes("|");
  const logic = hasOr ? "or" : "and";
  const separator = hasOr ? "|" : "&";
  const conditions = trimmed.split(separator).map((part) => {
    const partTrimmed = part.trim();
    if (partTrimmed.includes("!=")) {
      const [key2, value2] = partTrimmed.split("!=");
      return { key: key2.trim(), op: "neq", value: value2.trim() };
    }
    const [key, value] = partTrimmed.split("=");
    const trimmedKey = key.trim();
    const trimmedValue = value?.trim();
    if (trimmedValue === "undefined" || trimmedValue === "null") {
      return { key: trimmedKey, op: "notExists" };
    }
    if (trimmedValue === "*") {
      return { key: trimmedKey, op: "exists" };
    }
    return { key: trimmedKey, op: "eq", value: trimmedValue };
  });
  return { conditions, logic };
}
function checkCondition(queryParams, condition) {
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
function matchesQueryPattern(queryParams, parsed) {
  if (parsed.logic === "or") {
    return parsed.conditions.some((c) => checkCondition(queryParams, c));
  }
  return parsed.conditions.every((c) => checkCondition(queryParams, c));
}
function processLocalSuspenseTemplates(destinationUrl, formData, currentPathname, requestMethod = formData ? "post" : "get", options = {}) {
  const method = requestMethod.toLowerCase();
  const allowRuntimeCache = options.allowRuntimeCache ?? true;
  const bypassRouteCache = options.bypassRouteCache ?? false;
  let block = false;
  const targetPathname = destinationUrl.pathname;
  console.log(
    "Processing local suspense templates for pathname:",
    targetPathname
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
    const urlPattern = new URLPattern({ pathname: rawPattern });
    const execResult = urlPattern.exec({ pathname: targetPathname });
    if (!execResult) continue;
    console.log("Found path match with template:", template);
    const queryPattern = template.getAttribute("query");
    if (queryPattern) {
      const conditions = parseQueryPattern(queryPattern);
      if (!matchesQueryPattern(destinationUrl.searchParams, conditions)) {
        console.log("Query pattern not matched:", queryPattern);
        continue;
      }
    }
    console.log("Query pattern matched");
    let templateToRender = template;
    const redirectTo = template.getAttribute(SPA_REDIRECT_ATTR);
    const redirectPathname = redirectTo ? new URL(redirectTo, destinationUrl.href).pathname : void 0;
    if (redirectTo) {
      const redirectedTemplate = redirectPathname ? getCachedRouteTemplate(redirectPathname) : null;
      if (allowRuntimeCache && redirectedTemplate && isRuntimeCachedRouteTemplate(redirectedTemplate) && redirectedTemplate.content.childElementCount > 0) {
        console.log(
          "Using canonical runtime template via redirect alias:",
          redirectPathname
        );
        templateToRender = redirectedTemplate;
      }
    }
    const isRuntimeTemplate = isRuntimeCachedRouteTemplate(templateToRender);
    if (isRuntimeTemplate && isEmptyRuntimeTemplate(templateToRender)) {
      console.log(
        "Skipping empty runtime template for active route:",
        targetPathname
      );
      continue;
    }
    const blockNav = templateToRender.hasAttribute("data-nav-block");
    const cacheCurrentPath = method === "get" && !bypassRouteCache ? currentPathname : void 0;
    const pathParams = execResult.pathname.groups;
    const queryParams = destinationUrl.searchParams;
    const params = {
      ...pathParams,
      ...Object.fromEntries(queryParams.entries()),
      ...formData ? Object.fromEntries(
        Array.from(formData.entries()).map(([key, value]) => [key, value.toString()])
      ) : {}
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
      null
    );
    let node = cloneWalker.nextNode();
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
        const el = node;
        if (el.hasAttributes()) {
          for (const attr of Array.from(el.attributes)) {
            if (typeof attr.value === "string" && attr.value.includes("$[")) {
              let newVal = attr.value;
              for (const [key, value] of Object.entries(params)) {
                newVal = newVal.replace(
                  new RegExp(`\\$\\[${key}\\]`, "g"),
                  value
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
      isRuntimeTemplate ? "runtime" : "authored"
    );
    processIncomingHtml(fragment, document, {
      cacheCurrentPath,
      bypassRouteCache,
      activeRouteRegistrations: method === "get" && targetPathname && !bypassRouteCache ? [
        {
          pathname: targetPathname,
          redirectTo: redirectTo ?? void 0
        },
        redirectPathname && redirectPathname !== targetPathname ? {
          pathname: redirectPathname
        } : null
      ].filter(
        (entry) => entry !== null
      ) : void 0,
      activeRoutePath: method === "get" && !bypassRouteCache ? redirectPathname || targetPathname : void 0
    });
    if (redirectTo) {
      const redirectUrl = new URL(redirectTo, destinationUrl.href);
      const destinationPathWithSearch = destinationUrl.pathname + destinationUrl.search + destinationUrl.hash;
      const redirectPathWithSearch = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
      if (redirectPathWithSearch !== destinationPathWithSearch) {
        console.log(
          "Applying cached route redirect from runtime template:",
          redirectPathWithSearch
        );
        navigation.navigate(redirectPathWithSearch, {
          history: "replace",
          info: {
            onlyUpdateUrl: true
          }
        });
      }
    }
    if (blockNav) {
      console.warn("Blocking navigation for this local route.");
      block = true;
    }
    break;
  }
  return block;
}
export {
  processLocalSuspenseTemplates
};
