import { processIncomingHtml } from "./processIncomingHtml.js";
function activateScripts(container) {
  const scripts = container.querySelectorAll("script");
  scripts.forEach((script) => {
    const newScript = document.createElement("script");
    Array.from(script.attributes).forEach((attr) => {
      newScript.setAttribute(attr.name, attr.value);
    });
    newScript.textContent = script.textContent;
    script.replaceWith(newScript);
  });
}
async function processIncomingData(response) {
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
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    console.log("chunk length: ", chunk.length);
    const text = decoder.decode(chunk, { stream: true });
    console.log("Received chunk:", text);
    if (text.length === 0) continue;
    buffer += text;
    if (buffer.includes("</update>")) {
      const updates = buffer.split("</update>");
      buffer = updates.pop() || "";
      for (const updateContent of updates) {
        if (!updateContent.trim()) continue;
        const fullUpdate = updateContent + "</update>";
        console.log(
          "Chunk parsed and processed (update length):",
          fullUpdate.length
        );
        const updateFragment = globalThis.document.createRange().createContextualFragment(fullUpdate);
        const headTemplate = updateFragment.querySelector("template");
        const headSearchRoot = headTemplate ? headTemplate.content : updateFragment;
        const head = headSearchRoot.querySelector("head-update");
        if (head) {
          const headChildren = Array.from(head.children);
          await Promise.all(headChildren.map((child) => {
            if (child instanceof HTMLScriptElement && child.src) {
              const srcAttr = child.getAttribute("src");
              const exists = globalThis.document.head.querySelector(
                `script[src="${srcAttr}"]`
              );
              if (exists) return;
            } else if (child instanceof HTMLLinkElement && child.rel === "stylesheet" && child.href) {
              const hrefAttr = child.getAttribute("href");
              const exists = globalThis.document.head.querySelector(
                `link[rel="stylesheet"][href="${hrefAttr}"]`
              );
              if (exists) return;
              return new Promise((resolve, reject) => {
                child.onload = () => resolve();
                child.onerror = () => reject(new Error(`Failed to load stylesheet: ${hrefAttr}`));
                globalThis.document.head.appendChild(child);
              });
            }
            globalThis.document.head.appendChild(child);
          }));
        }
        const div = document.createElement("div");
        div.setHTMLUnsafe(fullUpdate);
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
        activateScripts(fragment);
        processIncomingHtml(fragment);
      }
    } else if (buffer.startsWith("<!DOCTYPE html><update>") || buffer.startsWith("<update id=")) {
      console.log("Incomplete HTML fragment, waiting for next chunk.");
    } else {
      const fragment = globalThis.document.createRange().createContextualFragment(buffer);
      const children = Array.from(fragment.children);
      const popupDialog = document.getElementById(
        "global-modal"
      );
      children.forEach((child) => {
        popupDialog.appendChild(child);
      });
      popupDialog.showModal();
      buffer = "";
    }
  }
}
export {
  processIncomingData
};
