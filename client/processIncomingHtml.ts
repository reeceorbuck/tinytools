/**
 * Connect incoming elements to the document so lifecycle-driven features can
 * process them.
 */

import {
  type PartialContentProcessingOptions,
  setPartialContentContext,
} from "./partialContentContext.ts";

export interface ProcessIncomingHtmlOptions
  extends PartialContentProcessingOptions {}

export function processIncomingHtml(
  fragment: DocumentFragment | Element,
  scope: ParentNode = document,
  options: ProcessIncomingHtmlOptions = {},
) {
  const incomingElements = Array.from(fragment.children);
  const context = {
    scope,
    options,
    incomingElements,
    state: new Set<string>(),
  };

  for (const incoming of incomingElements) {
    if (incoming.tagName === "PARTIAL-CONTENT") {
      setPartialContentContext(incoming, context);
      document.body.appendChild(incoming);
      continue;
    }

    if (incoming.tagName === "SCRIPT") {
      document.body.appendChild(incoming);
      continue;
    }

    console.error(
      `Ignoring unexpected incoming <${incoming.tagName.toLowerCase()}>; ` +
        "body updates must use <partial-content>.",
    );
  }
}
