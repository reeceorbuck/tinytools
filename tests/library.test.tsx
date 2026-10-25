import { assertEquals, assertStringIncludes } from "@std/assert";
import { imports } from "../clientTools.ts";
// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../jsx-runtime.ts";
import {
  CounterSignalComponent,
  DatePickerSignalComponent,
  DialogSignalComponent,
  DisclosureSignalComponent,
  ListSignalComponent,
  SearchFilterSignalComponent,
} from "../components/library/mod.ts";
import { dateFunctions } from "../components/library/DatePicker.tsx";

const linkOf = (html: string) => /tt-link="([^"]+)"/.exec(html)?.[1];

/** Renders a component's result, async children included. */
const render = async (result: unknown) =>
  String(await (await result as { toString(): unknown }).toString());

Deno.test("the library counter's parts share one count", async () => {
  const { component } = await imports(CounterSignalComponent);
  const counter = component.instance();
  const display = await render(counter.CounterDisplay({}));
  const button = await render(counter.Increment({ by: -5 }));
  assertStringIncludes(display, ">0</signal-text></output>");
  assertStringIncludes(button, 'data-by="-5"');
  assertStringIncludes(button, ">−5</button>");
  assertEquals(linkOf(display), linkOf(button));
  // The count shown elsewhere joins the same instance, rendered display or not.
  const outside = await render(
    <span>{counter.CounterDisplay.signal.count}</span>,
  );
  assertEquals(linkOf(outside), linkOf(button));
});

Deno.test("the library date picker's parts share one date", async () => {
  const { component } = await imports(DatePickerSignalComponent);
  const picker = component.instance();
  const input = await render(
    <picker.DateInput name="day" value="2026-10-23" skipWeekends />,
  );
  const weekday = await render(<picker.Weekday value="2026-10-23" />);
  const back = await render(<picker.Step by={-1} />);
  const jump = await render(<picker.Step by={2} unit="week">»</picker.Step>);
  const today = await render(<picker.Today />);
  assertStringIncludes(input, 'type="date" name="day" value="2026-10-23"');
  assertStringIncludes(input, "data-skip-weekends=");
  // The day is named before the page's script runs.
  assertStringIncludes(weekday, ">Friday</signal-text></output>");
  assertStringIncludes(back, 'aria-label="Previous" title="Previous"');
  assertStringIncludes(back, ">‹</button>");
  assertStringIncludes(jump, 'aria-label="Next 2 weeks"');
  assertStringIncludes(jump, 'data-by="2" data-unit="week"');
  assertStringIncludes(jump, ">»</button>");
  assertStringIncludes(today, ">Today</button>");
  for (const part of [weekday, back, jump, today]) {
    assertEquals(linkOf(part), linkOf(input));
  }
  // A week input, and the date shown elsewhere through its signal.
  const week = component.instance();
  const weekInput = await render(
    <week.DateInput type="week" name="week" value="2026-W43" />,
  );
  assertStringIncludes(weekInput, 'type="week"');
  assertEquals(
    linkOf(await render(<span>{week.DateInput.signal.date}</span>)),
    linkOf(weekInput),
  );
  assertEquals(linkOf(weekInput) === linkOf(input), false);
});

Deno.test("the library date picker steps days, weekdays and weeks", () => {
  const { moveDate, weekday } = dateFunctions;
  assertEquals(moveDate("2026-10-25", 1, "date"), "2026-10-26");
  assertEquals(moveDate("2026-10-25", -7, "date"), "2026-10-18");
  // Across a month and a leap day.
  assertEquals(moveDate("2028-02-28", 1, "date"), "2028-02-29");
  assertEquals(moveDate("2026-12-31", 1, "date"), "2027-01-01");
  // Friday forward and Monday back skip the weekend, in their direction.
  assertEquals(moveDate("2026-10-23", 1, "date", true), "2026-10-26");
  assertEquals(moveDate("2026-10-26", -1, "date", true), "2026-10-23");
  assertEquals(moveDate("2026-10-23", 7, "date", true), "2026-10-30");
  // ISO weeks, across years with 52 and 53 weeks.
  assertEquals(moveDate("2026-W43", 7, "week"), "2026-W44");
  assertEquals(moveDate("2026-W53", 7, "week"), "2027-W01");
  assertEquals(moveDate("2027-W01", -7, "week"), "2026-W53");
  assertEquals(moveDate("2025-W52", 7, "week"), "2026-W01");
  assertEquals(moveDate("2025-W01", -7, "week"), "2024-W52");
  // Today, in either format.
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(moveDate("", 0, "date")), true);
  assertEquals(/^\d{4}-W\d{2}$/.test(moveDate("", 0, "week")), true);
  assertEquals(weekday("2026-10-25"), "Sunday");
  assertEquals(weekday("2026-W43"), "");
  assertEquals(weekday(""), "");
});

Deno.test("the library list holds its Items and links its form", async () => {
  const { component } = await imports(ListSignalComponent);
  const tasks = component.instance();
  const list = await render(
    <tasks.List label="Tasks">
      <tasks.Item dismissable>Order stock</tasks.Item>
      <tasks.Item>{"<b>bold</b>"}</tasks.Item>
      <tasks.Item label="Recalls" class="mine">
        <a href="/recalls" data-test="recalls">Call back patients</a>
      </tasks.Item>
    </tasks.List>,
  );
  const form = await render(
    tasks.AddItem({ placeholder: "New task", dismissable: true }),
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
  // tasks.Item labels are text.
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
  assertEquals(
    (await render(<tasks.Item>Alone</tasks.Item>)).includes("draggable"),
    false,
  );
});

Deno.test("a library list of Rows is the body of the page's table", async () => {
  const { component } = await imports(ListSignalComponent);
  const costs = component.instance();
  const table = await render(
    <table>
      <thead>
        <tr>
          <th>Cost</th>
        </tr>
      </thead>
      <costs.List
        reorderable={false}
        newItem={{ reference: "costs_12345.cells" }}
      >
        <costs.Row>
          <td>
            <input name="cost" />
          </td>
        </costs.Row>
        <costs.Row dismissable label="Second">
          <td>Second</td>
        </costs.Row>
      </costs.List>
    </table>,
  );
  const button = await render(
    <costs.AddButton label="Add a cost">+</costs.AddButton>,
  );
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

Deno.test("the library search filter's parts share one query", async () => {
  const { component } = await imports(SearchFilterSignalComponent);
  const filter = component.instance();
  const input = await render(
    <filter.FilterInput label="Filter items" value="glo" />,
  );
  const results = await render(
    <filter.Results as="tbody">
      <tr data-filter="nitrile gloves">
        <td>Gloves</td>
      </tr>
    </filter.Results>,
  );
  const count = await render(<filter.MatchCount />);
  const none = await render(<filter.NoMatches />);
  assertStringIncludes(input, 'type="search"');
  assertStringIncludes(input, 'name="search"');
  assertStringIncludes(input, 'aria-label="Filter items"');
  assertStringIncludes(input, 'placeholder="Filter items" value="glo"');
  assertStringIncludes(results, "<tbody ");
  assertStringIncludes(results, '<tr data-filter="nitrile gloves">');
  // The count is empty, and the message hidden, until a query filters.
  assertStringIncludes(count, "></signal-text></output>");
  assertStringIncludes(none, '<p hidden=""');
  assertStringIncludes(none, ">No matches.</p>");
  for (const part of [results, count, none]) {
    assertEquals(linkOf(part), linkOf(input));
  }
});

Deno.test("the library dialog's parts share one open state", async () => {
  const { component } = await imports(DialogSignalComponent);
  const editor = component.instance();
  const open = await render(<editor.Open>Edit</editor.Open>);
  const panel = await render(
    <editor.Panel label="Edit details" open>
      <editor.Close />
    </editor.Panel>,
  );
  assertStringIncludes(open, 'aria-haspopup="dialog"');
  assertStringIncludes(open, ">Edit</button>");
  assertStringIncludes(panel, '<dialog class="panel_');
  assertStringIncludes(panel, 'aria-label="Edit details"');
  // Modal unless `modeless`, and opened by the script rather than `open`.
  assertStringIncludes(panel, 'data-modal="" data-start-open=""');
  assertEquals(/<dialog[^>]* open[ =>]/.test(panel), false);
  assertStringIncludes(panel, 'aria-label="Close" title="Close"');
  assertEquals(linkOf(open), linkOf(panel));
  assertEquals(new Set(panel.match(/tt-link="[^"]+"/g)).size, 1);
  const other = component.instance();
  const modeless = await render(<other.Panel modeless>Note</other.Panel>);
  assertEquals(modeless.includes("data-modal"), false);
  assertEquals(linkOf(modeless) === linkOf(panel), false);
});

Deno.test("a library confirm asks before the button it wraps", async () => {
  const { component } = await imports(DialogSignalComponent);
  const deletion = component.instance();
  const confirm = await render(
    <deletion.Confirm message="Delete this task?" confirmLabel="Delete">
      <button type="submit" class="danger" name="op" value="delete">
        Delete
      </button>
    </deletion.Confirm>,
  );
  // The page's button is kept as it is, and the wrapper is no component
  // boundary, so the page's styles still reach it.
  assertStringIncludes(
    confirm,
    '<button type="submit" class="danger" name="op" value="delete">',
  );
  assertEquals(/<tiny-confirm[^>]*data-tc/.test(confirm), false);
  assertEquals(/<tiny-confirm[^>]*class=/.test(confirm), false);
  assertStringIncludes(confirm, 'tt-handler-click="');
  assertStringIncludes(confirm, 'aria-label="Delete this task?"');
  assertStringIncludes(confirm, "<p>Delete this task?</p>");
  // Cancel takes focus.
  assertStringIncludes(confirm, 'data-answer="no" autofocus="">Cancel');
  assertStringIncludes(confirm, 'data-answer="yes">Delete</button>');
  const plain = await render(
    <deletion.Confirm message="Release?" cancelLabel="Keep">
      <button type="submit">Release</button>
    </deletion.Confirm>,
  );
  assertStringIncludes(plain, 'data-answer="no" autofocus="">Keep');
  assertStringIncludes(plain, 'data-answer="yes">Confirm</button>');
});

Deno.test("the library disclosure's parts share one open state", async () => {
  const { component } = await imports(DisclosureSignalComponent);
  const section = component.instance();
  const details = await render(
    <section.Details summary="Filters" name="filters" remember="chart" open>
      Body
    </section.Details>,
  );
  const toggle = await render(<section.Toggle>Filters</section.Toggle>);
  assertStringIncludes(details, '<details open="" name="filters"');
  assertStringIncludes(details, 'data-remember="chart"');
  assertStringIncludes(details, "<summary>Filters</summary>");
  assertStringIncludes(details, 'tt-handler-toggle="');
  assertStringIncludes(toggle, 'aria-expanded="false"');
  assertEquals(linkOf(details), linkOf(toggle));
  const other = component.instance();
  const closed = await render(<other.Details summary="S" />);
  assertEquals(closed.includes("open="), false);
  assertEquals(closed.includes("data-remember"), false);
});
