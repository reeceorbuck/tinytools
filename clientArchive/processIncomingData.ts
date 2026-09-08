/**
 * Process Incoming Data client script for @tinytools/hono-tools
 *
 * Handles streaming HTML responses and processes update fragments.
 */

import { processIncomingHtml } from "./processIncomingHtml.ts";

export interface ProcessIncomingDataOptions {
  cacheCurrentPath?: string;
  activeRoutePath?: string;
  activeRouteRegistrations?: Array<{
    pathname: string;
    redirectTo?: string;
  }>;
  updateCachedTemplates?: boolean;
  bypassRouteCache?: boolean;
  navGeneration?: number;
}

/**
 * Activates scripts within a fragment by replacing them with clones.
 * Scripts added via setHTMLUnsafe don't execute because they're not parser-inserted.
 * Cloning and replacing them makes them executable.
 */
function activateScripts(container: DocumentFragment | Element) {
  const scripts = container.querySelectorAll("script");
  scripts.forEach((script) => {
    const newScript = document.createElement("script");
    // Copy all attributes
    Array.from(script.attributes).forEach((attr) => {
      newScript.setAttribute(attr.name, attr.value);
    });
    // Copy inline content
    newScript.textContent = script.textContent;
    script.replaceWith(newScript);
  });
}

export async function processIncomingData(
  response: Response,
  options: ProcessIncomingDataOptions = {},
) {
  const contentType = response.headers.get("Content-Type") || "";
  console.log(`Response Content-Type: ${contentType}`);

  if (response.body === null || !contentType.startsWith("text/html")) {
    console.log("No content to render, response status: ", response.status);
    if (contentType.startsWith("application/json")) {
      const json = await response.json();
      console.log("JSON response:", json);
    }
    return;
  }

  // Use a streaming TextDecoder to avoid splitting multibyte chars across chunks
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    console.log("chunk length: ", chunk.length);
    const text = decoder.decode(chunk, { stream: true });
    // console.log("Received chunk:", text);
    if (text.length === 0) continue;
    buffer += text;

    // Try to parse and process only when we have a valid HTML fragment
    if (buffer.includes("</update>")) {
      // Split buffer to handle multiple <update> tags that may arrive together
      const updates = buffer.split("</update>");
      // Last element is either empty or incomplete - keep it in buffer
      buffer = updates.pop() || "";

      for (const updateContent of updates) {
        if (!updateContent.trim()) continue;

        const fullUpdate = updateContent + "</update>";
        console.log(
          "Chunk parsed and processed (update):",
          fullUpdate,
        );

        const updateFragment = globalThis.document.createRange()
          .createContextualFragment(fullUpdate);
        const updateElement = updateFragment.querySelector("update");
        if (!updateElement) continue;
        document.body.append(...updateElement.childNodes);
      }
    } else if (
      buffer.startsWith("<!DOCTYPE html><update") ||
      buffer.startsWith("<update")
    ) {
      console.log("Incomplete HTML fragment, waiting for next chunk.");
    } else {
      // Then its not a partial
      // Append to the global modal dialog for display (for debugging/testing)
      const fragment = globalThis.document.createRange()
        .createContextualFragment(buffer);
      const children = Array.from(fragment.children);
      const popupDialog = document.getElementById(
        "global-modal",
      ) as HTMLDialogElement;
      children.forEach((child) => {
        popupDialog.appendChild(child);
      });
      popupDialog.showModal();
      buffer = ""; // clear once successfully processed
    }
  }
}
