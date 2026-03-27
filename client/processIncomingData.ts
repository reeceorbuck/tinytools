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
    console.log("Received chunk:", text);
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
          "Chunk parsed and processed (update length):",
          fullUpdate.length,
        );
        const updateFragment = globalThis.document.createRange()
          .createContextualFragment(fullUpdate);

        // Handle case where content is wrapped in <template> tags
        // Template content is stored in .content, not as direct children
        const headTemplate = updateFragment.querySelector("template");
        const headSearchRoot = headTemplate
          ? headTemplate.content
          : updateFragment;

        const head = headSearchRoot.querySelector("head-update");
        if (head) {
          const headChildren = Array.from(head.children);
          await Promise.all(headChildren.map((child) => {
            // Check if the element already exists in the head
            if (child instanceof HTMLScriptElement && child.src) {
              const srcAttr = child.getAttribute("src");
              const exists = globalThis.document.head.querySelector(
                `script[src="${srcAttr}"]`,
              );
              if (exists) return;
            } else if (
              child instanceof HTMLLinkElement &&
              child.rel === "stylesheet" &&
              child.href
            ) {
              const hrefAttr = child.getAttribute("href");
              const exists = globalThis.document.head.querySelector(
                `link[rel="stylesheet"][href="${hrefAttr}"]`,
              );
              if (exists) return;
              // Return a promise that resolves when stylesheet loads
              return new Promise<void>((resolve, reject) => {
                child.onload = () => resolve();
                child.onerror = () =>
                  reject(new Error(`Failed to load stylesheet: ${hrefAttr}`));
                globalThis.document.head.appendChild(child);
              });
            }
            globalThis.document.head.appendChild(child);
          }));
        }

        // Use setHTMLUnsafe to preserve shadow DOM in templates
        const div = document.createElement("div");
        div.setHTMLUnsafe(fullUpdate);

        // Handle case where content is wrapped in <template> tags
        // Template content is stored in .content, not as direct children
        const template = div.querySelector("template");
        const searchRoot = template ? template.content : div;

        const updateBody = searchRoot.querySelector("body-update");
        if (!updateBody) {
          console.error("No body found in update fragment");
          continue;
        }
        console.log("Processing update body: ", updateBody);
        const fragment = new DocumentFragment();
        Array.from(updateBody.childNodes).forEach((child) => {
          fragment.appendChild(child);
        });

        // Activate scripts by replacing them with clones (setHTMLUnsafe doesn't execute scripts)
        activateScripts(fragment);

        processIncomingHtml(fragment, document, options);
      }
    } else if (
      buffer.startsWith("<!DOCTYPE html><update>") ||
      buffer.startsWith("<update id=")
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
