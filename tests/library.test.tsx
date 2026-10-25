import { assertEquals, assertStringIncludes } from "@std/assert";
import { imports } from "../clientTools.ts";
// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../jsx-runtime.ts";
import {
  CounterSignalComponent,
  ListSignalComponent,
} from "../components/library/mod.ts";

const linkOf = (html: string) => /tt-link="([^"]+)"/.exec(html)?.[1];

/** Renders a component's result, async children included. */
const render = async (result: unknown) =>
  String(await (await result as { toString(): unknown }).toString());

Deno.test("the library counter's parts share one count", async () => {
  const { component } = await imports(CounterSignalComponent);
  const { CounterDisplay, Increment } = component.instance();
  const display = await render(CounterDisplay({}));
  const button = await render(Increment({ by: -5 }));
  assertStringIncludes(display, ">0</signal-text></output>");
  assertStringIncludes(button, 'data-by="-5"');
  assertStringIncludes(button, ">−5</button>");
  assertEquals(linkOf(display), linkOf(button));
});

Deno.test("the library list holds its Items and links its form", async () => {
  const { component } = await imports(ListSignalComponent);
  const { List, Item, AddItem } = component.instance();
  const list = await render(
    <List label="Tasks">
      <Item dismissable>Order stock</Item>
      <Item>{"<b>bold</b>"}</Item>
      <Item label="Recalls" class="mine">
        <a href="/recalls" data-test="recalls">Call back patients</a>
      </Item>
    </List>,
  );
  const form = await render(
    AddItem({ placeholder: "New task", dismissable: true }),
  );
  assertStringIncludes(list, '<ol class="list_');
  assertEquals(list.match(/<li /g)?.length, 3);
  assertStringIncludes(list, 'aria-label="Tasks"');
  // Reordering is on by default, and reaches the items as they render.
  assertStringIncludes(list, 'data-reorderable=""');
  assertStringIncludes(list, 'tt-handler-dragstart="');
  assertEquals(list.match(/draggable="true" tabindex="0"/g)?.length, 3);
  // Dismissing is each item's own.
  assertEquals(list.match(/data-dismiss=""/g)?.length, 1);
  assertStringIncludes(list, 'aria-label="Dismiss Order stock"');
  // Text children name the item; other children need a `label`.
  assertStringIncludes(list, 'data-label="Order stock"');
  assertStringIncludes(list, 'data-label="Recalls"');
  // The caller's markup is kept as it is, and the item takes its `class`.
  assertStringIncludes(list, '<a href="/recalls" data-test="recalls">');
  assertEquals(/<li class="listItem_\w+ sb mine"/.test(list), true);
  // Item labels are text.
  assertStringIncludes(list, "&lt;b&gt;bold&lt;/b&gt;");
  // Every part shares the instance; none needs an id to repeat.
  assertEquals(new Set(list.match(/tt-link="[^"]+"/g)).size, 1);
  assertEquals(list.includes(" id="), false);
  assertStringIncludes(form, 'placeholder="New task"');
  assertStringIncludes(form, 'data-dismissable=""');
  assertEquals(linkOf(list), linkOf(form));

  // Another instance is another list.
  const other = component.instance();
  assertEquals(linkOf(await render(<other.List />)) === linkOf(list), false);
  // An item outside a list is not reorderable.
  assertEquals((await render(<Item>Alone</Item>)).includes("draggable"), false);
});

Deno.test("a library list of Rows is the body of the page's table", async () => {
  const { component } = await imports(ListSignalComponent);
  const { List, Row, AddButton } = component.instance();
  const table = await render(
    <table>
      <thead>
        <tr>
          <th>Cost</th>
        </tr>
      </thead>
      <List reorderable={false} newItem={{ reference: "costs_12345.cells" }}>
        <Row>
          <td>
            <input name="cost" />
          </td>
        </Row>
        <Row dismissable label="Second">
          <td>Second</td>
        </Row>
      </List>
    </table>,
  );
  const button = await render(<AddButton label="Add a cost">+</AddButton>);
  assertStringIncludes(table, "</thead><tbody ");
  assertEquals(table.match(/<tr data-list-item/g)?.length, 2);
  assertStringIncludes(table, 'data-new-item="costs_12345.cells"');
  // Not reorderable: no sorting handlers to bind, nothing draggable.
  assertEquals(table.includes("data-reorderable"), false);
  assertEquals(table.includes("dragstart"), false);
  assertEquals(table.includes("draggable"), false);
  // A dismissable row gets its button in a cell of its own.
  assertStringIncludes(
    table,
    '<td><button type="button" class="dismissButton_',
  );
  // No scoped class on the body or rows, which would stop the page's styles.
  assertEquals(/<(tbody|tr) class=/.test(table), false);
  assertStringIncludes(button, 'aria-label="Add a cost"');
  assertStringIncludes(button, ">+</button>");
  assertEquals(linkOf(table), linkOf(button));
});
