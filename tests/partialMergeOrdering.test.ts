import { assertEquals } from "@std/assert";
import { parseHTML } from "linkedom";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";
import { processIncomingDataTools } from "../handlers/processIncomingData.ts";
import { loadHandler } from "./helpers/loadHandler.ts";

void partialInsertHandlers;
void processIncomingDataTools;

type Handler = (this: unknown, event?: Event) => unknown;
const partialMergeContent = await loadHandler<Handler>("partialMergeContent");
const partialDelete = await loadHandler<Handler>("partialDelete");
const partialBlast = await loadHandler<Handler>("partialBlast");
const appendIncomingHtml = await loadHandler<Handler>("appendIncomingHtml");

function withDocument(html: string, run: (document: Document) => void) {
  const { document } = parseHTML(html);
  // linkedom's element.children lacks HTMLCollection.namedItem.
  const collection = Object.getPrototypeOf(document.body.children);
  if (!collection.namedItem) {
    collection.namedItem = function (this: Element[], name: string) {
      return this.find((element) => element.id === name) ?? null;
    };
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  try {
    run(document);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

function partial(document: Document, html: string) {
  document.body.insertAdjacentHTML("beforeend", html);
  return document.body.lastElementChild!;
}

const listIds = (document: Document) =>
  Array.from(document.getElementById("list")!.children).map((child) =>
    child.id
  );

Deno.test("partialMergeContent inserts and moves children before an anchor", () => {
  withDocument(
    '<html><body><ul id="list"><li id="head"></li><li id="a"></li><li id="c"></li><li id="d"></li></ul></body></html>',
    (document) => {
      // New child: the first anchor present wins.
      partialMergeContent.call(partial(
        document,
        '<template for-partial-id="list" existing="substitute" new="append" insert-before="missing c d"><li id="b"></li></template>',
      ));
      assertEquals(listIds(document), ["head", "a", "b", "c", "d"]);

      // Existing child is substituted and moved to its new position.
      partialMergeContent.call(partial(
        document,
        '<template for-partial-id="list" existing="substitute" new="append" insert-before="a"><li id="d" class="moved"></li></template>',
      ));
      assertEquals(listIds(document), ["head", "d", "a", "b", "c"]);
      assertEquals(document.getElementById("d")!.className, "moved");

      // An empty list (or no anchor present) places by the `new` mode.
      partialMergeContent.call(partial(
        document,
        '<template for-partial-id="list" existing="substitute" new="append" insert-before=""><li id="a" class="last"></li><li id="e"></li></template>',
      ));
      assertEquals(listIds(document), ["head", "d", "b", "c", "a", "e"]);

      // Without insert-before a substitute stays in place.
      partialMergeContent.call(partial(
        document,
        '<template for-partial-id="list" existing="substitute" new="append"><li id="d"></li></template>',
      ));
      assertEquals(listIds(document), ["head", "d", "b", "c", "a", "e"]);

      // new="ignore" doesn't insert even with an anchor.
      partialMergeContent.call(partial(
        document,
        '<template for-partial-id="list" existing="substitute" new="ignore" insert-before="d"><li id="z"></li></template>',
      ));
      assertEquals(listIds(document), ["head", "d", "b", "c", "a", "e"]);
    },
  );
});

Deno.test("optional-target partials skip a missing target silently", () => {
  withDocument("<html><body></body></html>", (document) => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      for (
        const handler of [partialDelete, partialBlast, partialMergeContent]
      ) {
        handler.call(partial(
          document,
          '<template for-partial-id="gone" optional-target></template>',
        ));
      }
      assertEquals(errors, []);
      partialDelete.call(
        partial(document, '<template for-partial-id="gone"></template>'),
      );
      assertEquals(errors.length, 1);
    } finally {
      console.error = originalError;
    }
  });
});

Deno.test("appendIncomingHtml marks applied partials optional-target", () => {
  withDocument("<html><body></body></html>", (document) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/items/1" },
    });
    try {
      const update = document.createElement("update");
      update.innerHTML =
        '<template for-partial-id="item-1"></template><template></template>';
      appendIncomingHtml.call(
        document.body,
        new CustomEvent("incomingdata", {
          detail: { type: "html", element: update, paths: ["/items/:id"] },
        }),
      );
      const templates = document.body.querySelectorAll("template");
      assertEquals(templates[0].hasAttribute("optional-target"), true);
      assertEquals(templates[1].hasAttribute("optional-target"), false);
    } finally {
      if (original) Object.defineProperty(globalThis, "location", original);
      else Reflect.deleteProperty(globalThis, "location");
    }
  });
});
