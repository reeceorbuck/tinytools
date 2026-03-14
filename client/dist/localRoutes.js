import { processIncomingHtml } from "./processIncomingHtml.js";
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
function processLocalSuspenseTemplates(destinationUrl, formData) {
  const method = formData ? "post" : "get";
  let block = false;
  const noParamHref = destinationUrl.origin + destinationUrl.pathname;
  console.log(
    "Processing local suspense templates for noParamHref URL:",
    noParamHref
  );
  const templates = document.querySelectorAll(
    "template[path]"
  );
  for (const template of templates) {
    const rawPattern = template.getAttribute("path");
    if (!rawPattern) continue;
    const rawMethod = template.getAttribute("method") || "get";
    if (rawMethod !== method) continue;
    console.log("Matched method: ", rawMethod);
    const urlPattern = new URLPattern({ pathname: rawPattern });
    const execResult = urlPattern.exec(noParamHref);
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
    const pathParams = execResult.pathname.groups;
    const queryParams = destinationUrl.searchParams;
    const params = {
      ...pathParams,
      ...Object.fromEntries(queryParams.entries()),
      ...formData ? Object.fromEntries(
        Array.from(formData.entries()).map(([key, value]) => [key, value.toString()])
      ) : {}
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
    processIncomingHtml(fragment);
    const blockNav = template.hasAttribute("data-nav-block");
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
