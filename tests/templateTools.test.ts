import { assertEquals, assertRejects } from "@std/assert";
import { parseHTML } from "linkedom";
import { templateTools } from "../handlers/templateTools.ts";

/** Installs a linkedom document and a registered template bundle. */
function install(templateMarkup: string) {
  const window = parseHTML("<html><body></body></html>");
  const clone = () => {
    const template = window.document.createElement("template");
    template.innerHTML = templateMarkup;
    return template.content.cloneNode(true);
  };
  Object.assign(globalThis, {
    document: window.document,
    handlers: { cards_abc: { card: clone } },
  });
  return (markup: string) => {
    const template = window.document.createElement("template");
    template.innerHTML = markup;
    return template.content as unknown as ParentNode;
  };
}

function uninstall() {
  const globals = globalThis as Record<string, unknown>;
  delete globals.document;
  delete globals.handlers;
}

Deno.test("cloneTemplate fills named slots in place and the unnamed slot with the rest", async () => {
  const content = install(
    '<article>Hi <slot name="name"></slot>, see <slot name="when"></slot>.<slot></slot></article>',
  );
  try {
    const built = await templateTools.run.cloneTemplate(
      "cards_abc.card",
      content(
        '<span slot="name">Ann</span><span slot="when">TOMORROW</span><p>Body</p>',
      ),
    );
    const article = (built as unknown as ParentNode).querySelector("article")!;
    assertEquals(article.textContent, "Hi Ann, see TOMORROW.Body");
    // Each child was placed once, where its slot was, and the attribute is gone.
    assertEquals(
      article.innerHTML,
      "Hi <span>Ann</span>, see <span>TOMORROW</span>.<p>Body</p>",
    );
  } finally {
    uninstall();
  }
});

Deno.test("cloneTemplate reports a template its bundle does not export", async () => {
  install("<p></p>");
  try {
    await assertRejects(
      () => templateTools.run.cloneTemplate("cards_abc.missing"),
      Error,
      "Template cards_abc.missing not found in its bundle.",
    );
    await assertRejects(
      () => templateTools.run.cloneTemplate("nodot"),
      Error,
      "Invalid template reference: nodot",
    );
  } finally {
    uninstall();
  }
});
