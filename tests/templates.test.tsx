import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import { getEsbuild } from "../esbuildInit.ts";
import {
  cache,
  Handlers,
  imports,
  registeredClientTools,
  Styles,
  Templates,
} from "../clientTools.ts";
import { tiny } from "../honoFactory.tsx";
import { buildScriptFiles } from "../build.ts";
import {
  handlerBundles,
  handlers,
  resetImportRegistries,
} from "../clientFunctions.ts";

function reset() {
  (cache as { trustCache: boolean }).trustCache = false;
  handlers.clear();
  handlerBundles.clear();
  registeredClientTools.clear();
  cache.resetHashDependentState();
  resetImportRegistries();
}

/** Installs a linkedom document as the global one bundles read. */
function installDocument() {
  const window = parseHTML("<html><head></head><body></body></html>");
  Object.assign(globalThis, { document: window.document });
  return window.document;
}

function uninstallDocument() {
  delete (globalThis as Record<string, unknown>).document;
}

/** A row template bound to its own handlers and styles, plus a consumer. */
function createCollections(label = "Row") {
  const rowStyles = new Styles(import.meta.url, { row: "color: red;" });
  const rowHandlers = new Handlers(import.meta.url, {
    pick(this: HTMLElement) {
      this.toggleAttribute("data-picked");
    },
  });
  const rowTemplates = new Templates(import.meta.url, {
    row: async () => {
      const { fn, styled } = await imports(rowHandlers, rowStyles);
      return (
        <li class={styled.row} onClick={fn.pick}>
          {label} $[index]
        </li>
      );
    },
  });
  const listHandlers = new Handlers(import.meta.url, async () => {
    const { template } = await imports(rowTemplates);
    return {
      /** Appends a row numbered after the ones already there. */
      addRow(this: HTMLElement, _event?: Event) {
        this.append(
          template.row({ index: String(this.childElementCount + 1) }),
        );
      },
    };
  });
  return { rowStyles, rowHandlers, rowTemplates, listHandlers };
}

Deno.test({
  name: "Templates render once with their assets and clone in handlers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const directory = "./.test-build-output/templates";
    const { rowStyles, rowHandlers, rowTemplates, listHandlers } =
      createCollections();
    const other = createCollections("Line");
    try {
      await listHandlers.ensureDefined();
      const rendered = rowTemplates.rendered("row")!;
      const styleFile = `${rowStyles._styleFilenames.get("row")}.css`;
      const handlerFile = `${rowHandlers._handlerFilenames.get("pick")}.js`;
      assertStringIncludes(rendered.markup, "Row $[index]");
      assertStringIncludes(
        rendered.markup,
        `tt-handler-click="${rowHandlers._handlerFilenames.get("pick")}.pick"`,
      );
      assertStringIncludes(rendered.markup, 'class="row_');
      assertEquals(rendered.styleFiles, [styleFile]);
      assertEquals(rendered.handlerFiles, [handlerFile]);

      // On the server a clone is the interpolated markup.
      const appended: unknown[] = [];
      listHandlers.run.addRow.call(
        {
          childElementCount: 1,
          append: (...nodes: unknown[]) => appended.push(...nodes),
        } as never,
      );
      assertEquals(appended.length, 1);
      assertStringIncludes(String(appended[0]), "Row 2");
      assertEquals((appended[0] as { isEscaped: boolean }).isEscaped, true);

      await buildScriptFiles({ fresh: true, publicDir: directory });
      const templateFile = rowTemplates._handlerFilenames.get("row")!;
      // Different markup is a different bundle.
      await other.listHandlers.ensureDefined();
      assertNotEquals(
        templateFile,
        other.rowTemplates._handlerFilenames.get("row"),
      );
      const templateCode = await Deno.readTextFile(
        `${directory}/handlers/${templateFile}.js`,
      );
      assertStringIncludes(templateCode, "export function row(params)");
      assertStringIncludes(
        templateCode,
        `const templateStyles = ["/styles/${styleFile}"]`,
      );
      assertStringIncludes(templateCode, "Row $[index]");
      const consumerFile = listHandlers._handlerFilenames.get("addRow")!;
      const consumerCode = await Deno.readTextFile(
        `${directory}/handlers/${consumerFile}.js`,
      );
      assertStringIncludes(
        consumerCode,
        `import { row } from "./${templateFile}.js"`,
      );
      assertStringIncludes(consumerCode, "const template = { row }");

      // In the browser the clone is a fragment, and the bundle adds the
      // stylesheet it needs to the head.
      const document = installDocument();
      const module = await import(
        pathToFileURL(`${Deno.cwd()}/${directory}/handlers/${consumerFile}.js`)
          .href
      );
      const list = document.createElement("ul");
      module.addRow.call(list);
      module.addRow.call(list);
      assertStringIncludes(list.innerHTML, "Row 1");
      assertStringIncludes(list.innerHTML, "Row 2");
      assertStringIncludes(list.innerHTML, "tt-handler-click");
      const link = document.head.querySelector('link[rel="stylesheet"]');
      assertEquals(link?.getAttribute("href"), `/styles/${styleFile}`);
    } finally {
      uninstallDocument();
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "pages get a template's assets whether they render or only clone it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    const { rowStyles, rowHandlers, rowTemplates, listHandlers } =
      createCollections();
    try {
      const app = new tiny.Hono({ tools: "core" });
      app.get("/rendered", async (context) => {
        const { template, fn } = await tiny.imports(rowTemplates, listHandlers);
        return context.render(
          <ul onClick={fn.addRow}>{template.row({ index: "1" })}</ul>,
        );
      });
      app.get("/cloned", async (context) => {
        const { fn } = await tiny.imports(listHandlers);
        return context.render(<ul onClick={fn.addRow}></ul>);
      });
      const styleLink = `/styles/${rowStyles._styleFilenames.get("row")}.css`;

      const rendered = await (await app.request("/rendered")).text();
      assertStringIncludes(rendered, "Row 1</li>");
      assertStringIncludes(rendered, styleLink);
      // The handlers the markup binds to load as if the page rendered them.
      assertStringIncludes(
        rendered,
        `<script src="/handlers/${
          rowHandlers._handlerFilenames.get("pick")
        }.js" type="module">`,
      );

      const cloned = await (await app.request("/cloned")).text();
      assert(!cloned.includes("</li>"));
      // The stylesheet comes from the handler's reachable template bundle.
      assertStringIncludes(cloned, styleLink);
      assertStringIncludes(
        cloned,
        `/handlers/${rowTemplates._handlerFilenames.get("row")}.js`,
      );
    } finally {
      reset();
      (await getEsbuild()).stop();
    }
  },
});

Deno.test({
  name: "a template bound to the handlers that clone it is circular",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    reset();
    try {
      const collections: { handlers?: InstanceType<typeof Handlers> } = {};
      const templates = new Templates(import.meta.url, {
        item: async () => {
          const { fn } = await imports(collections.handlers!);
          return <li onClick={fn.add}>Item</li>;
        },
      });
      collections.handlers = new Handlers(import.meta.url, async () => {
        const { template } = await imports(templates);
        return {
          add(this: HTMLElement) {
            this.append(template.item());
          },
        };
      });
      await assertRejects(
        () => collections.handlers!.ensureDefined(),
        Error,
        "Circular handler definition dependency",
      );
    } finally {
      reset();
    }
  },
});
