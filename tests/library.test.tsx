import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { imports } from "../clientTools.ts";
// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../jsx-runtime.ts";
import {
  CarouselSignalComponent,
  ComboboxSignalComponent,
  CommandPaletteSignalComponent,
  CounterSignalComponent,
  DatePickerSignalComponent,
  DialogSignalComponent,
  DisclosureSignalComponent,
  ListSignalComponent,
  PopoverSignalComponent,
  SearchFilterSignalComponent,
  SelectionSignalComponent,
  StepsSignalComponent,
  TabsSignalComponent,
  ToastSignalComponent,
  TooltipSignalComponent,
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
  const styledInput = await render(<filter.FilterInput class="navFilter" />);
  assertMatch(styledInput, /class="filterInput_[^"]* navFilter[ "]/);
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
  assertEquals(panel.includes("data-restore-on-close"), false);
  // An id lets the page's invoker buttons open it; an open from them is
  // noted through `toggle`.
  const invoked = component.instance();
  const restorable = await render(
    <invoked.Panel id="password-dialog" restoreOnClose>Form</invoked.Panel>,
  );
  assertStringIncludes(
    restorable,
    '<dialog id="password-dialog" class="panel_',
  );
  assertStringIncludes(restorable, 'data-restore-on-close=""');
  assertStringIncludes(restorable, 'tt-handler-toggle="');
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

Deno.test("the library tabs' parts share one selected tab", async () => {
  const { component } = await imports(TabsSignalComponent);
  const views = component.instance();
  const list = await render(
    <views.List label="Views" value="xrays" remember="chart-view">
      <views.Tab value="notes">Notes</views.Tab>
      <views.Tab value="xrays">X-rays</views.Tab>
    </views.List>,
  );
  const shown = await render(
    <views.Panel value="xrays" selected>Films</views.Panel>,
  );
  const hidden = await render(<views.Panel value="notes">Notes</views.Panel>);
  assertStringIncludes(list, 'role="tablist"');
  assertStringIncludes(list, 'data-value="xrays" data-remember="chart-view"');
  // The list's value is selected, and only it reachable by Tab, before the
  // script runs.
  assertStringIncludes(
    list,
    'data-value="notes" aria-selected="false" tabindex="-1"',
  );
  assertStringIncludes(
    list,
    'data-value="xrays" aria-selected="true" tabindex="0"',
  );
  assertEquals(shown.includes("hidden"), false);
  assertStringIncludes(hidden, 'data-value="notes" hidden=""');
  for (const part of [shown, hidden]) assertEquals(linkOf(part), linkOf(list));
  // Without a value, every tab stays reachable until the first connect.
  const other = component.instance();
  const plain = await render(
    <other.List>
      <other.Tab value="a" />
      <other.Tab value="b" />
    </other.List>,
  );
  assertEquals(plain.match(/tabindex="0"/g)?.length, 2);
  assertStringIncludes(plain, ">a</button>");
  assertEquals(linkOf(plain) === linkOf(list), false);
});

Deno.test("the library toasts reach one toaster from any instance", async () => {
  const { component } = await imports(ToastSignalComponent);
  const toasts = component.instance();
  const toaster = await render(
    <toasts.Toaster position="top-right" duration={3000} />,
  );
  const trigger = await render(
    <toasts.Trigger message="Copied" variant="success" duration={0} />,
  );
  const toast = await render(
    <toasts.Toast variant="error">
      Not saved. <a href="/retry">Retry</a>
    </toasts.Toast>,
  );
  assertStringIncludes(toaster, '<tiny-toaster class="toaster_');
  assertStringIncludes(toaster, 'popover="manual" role="region"');
  assertStringIncludes(toaster, 'data-position="top-right"');
  assertStringIncludes(toaster, 'data-duration="3000"');
  // Toasts it builds take the toast class it carries.
  assertStringIncludes(toaster, 'data-toast-class="toast_');
  assertStringIncludes(trigger, 'data-message="Copied"');
  assertStringIncludes(trigger, 'data-variant="success" data-duration="0"');
  assertStringIncludes(trigger, ">Copied</button>");
  // A toast is hidden where it arrives, keeping the caller's markup.
  assertStringIncludes(toast, '<tiny-toast hidden="" data-variant="error"');
  assertStringIncludes(toast, '<a href="/retry">Retry</a>');
  // Page-wide, so nothing links them to an instance.
  for (const part of [toaster, trigger, toast]) {
    assertEquals(linkOf(part), undefined);
  }
});

Deno.test("the library popover's parts share one open state", async () => {
  const { component } = await imports(PopoverSignalComponent);
  const actions = component.instance();
  const trigger = await render(
    <actions.Trigger label="Patient actions">⋯</actions.Trigger>,
  );
  const content = await render(
    <actions.Content menu side="top" label="Patient actions">
      <actions.Item href="/patients/12/edit">Edit</actions.Item>
      <actions.Separator />
      <actions.Item variant="danger">Archive</actions.Item>
    </actions.Content>,
  );
  const close = await render(<actions.Close />);
  assertStringIncludes(trigger, 'aria-label="Patient actions"');
  // The content's id reaches the trigger once the page's script runs.
  assertEquals(trigger.includes("popovertarget"), false);
  assertStringIncludes(content, 'popover="auto"');
  assertStringIncludes(content, 'role="menu" aria-label="Patient actions"');
  assertStringIncludes(content, 'data-side="top"');
  assertStringIncludes(content, 'tt-handler-toggle="');
  assertStringIncludes(content, 'role="menuitem" class="item_');
  assertStringIncludes(content, 'href="/patients/12/edit" tabindex="-1"');
  assertStringIncludes(content, 'data-variant="danger"');
  assertStringIncludes(content, '<hr role="separator"');
  assertStringIncludes(close, ">Close</button>");
  for (const part of [content, close]) {
    assertEquals(linkOf(part), linkOf(trigger));
  }
  const other = component.instance();
  const dialog = await render(<other.Content>Hi</other.Content>);
  assertStringIncludes(dialog, 'role="dialog"');
  assertEquals(trigger.includes("aria-haspopup"), false);
  assertEquals(content.includes("data-match-trigger-width"), false);
});

Deno.test("a library popover menu can be styled and invoke a dialog", async () => {
  const { component } = await imports(PopoverSignalComponent);
  const account = component.instance();
  const trigger = await render(
    <account.Trigger class="accountCard" menu>Ann Lee</account.Trigger>,
  );
  const content = await render(
    <account.Content menu side="top" matchTriggerWidth label="Account">
      <account.Item commandFor="password-dialog" command="show-modal">
        Change password
      </account.Item>
    </account.Content>,
  );
  // The page's class joins the component's own.
  assertMatch(trigger, /class="scripted_[^"]* accountCard[ "]/);
  assertStringIncludes(trigger, 'aria-haspopup="menu"');
  assertStringIncludes(content, 'data-match-trigger-width=""');
  assertStringIncludes(
    content,
    'commandfor="password-dialog" command="show-modal"',
  );
});

Deno.test("the library selection's parts share one set of rows", async () => {
  const { component } = await imports(SelectionSignalComponent);
  const picked = component.instance();
  const row = await render(
    <picked.Checkbox value={12} name="ids" form="recalls" label="Ann Lee" />,
  );
  const all = await render(<picked.SelectAll />);
  const bar = await render(
    <picked.Bar>
      <picked.Count />
      <picked.Action formaction="/recalls/send">Send</picked.Action>
      <picked.Clear />
    </picked.Bar>,
  );
  // A real checkbox, so its form submits the chosen values.
  assertStringIncludes(row, 'type="checkbox" class="checkbox_');
  assertStringIncludes(row, 'value="12" name="ids" form="recalls"');
  assertStringIncludes(row, 'aria-label="Select Ann Lee"');
  assertStringIncludes(row, 'tt-handler-disconnect="');
  assertStringIncludes(all, 'aria-label="Select all"');
  // The bar is hidden, and the action disabled, while nothing is chosen.
  assertStringIncludes(bar, 'role="toolbar"');
  assertStringIncludes(bar, 'hidden="" tt-hidden-signal="');
  assertStringIncludes(bar, 'type="submit" formaction="/recalls/send"');
  assertStringIncludes(bar, 'disabled="" tt-disabled-signal="');
  assertStringIncludes(bar, ">Clear</button>");
  for (const part of [all, bar]) assertEquals(linkOf(part), linkOf(row));
  assertEquals(new Set(bar.match(/tt-link="[^"]+"/g)).size, 1);
});

Deno.test("the library command palette holds its items", async () => {
  const { component } = await imports(CommandPaletteSignalComponent);
  const commands = component.instance();
  const trigger = await render(<commands.Trigger />);
  const palette = await render(
    <commands.Palette label="Go to">
      <commands.Group heading="Pages">
        <commands.Item href="/stock" keywords="inventory" hint="G S">
          Stock
        </commands.Item>
        <commands.Item>New patient</commands.Item>
      </commands.Group>
    </commands.Palette>,
  );
  assertStringIncludes(trigger, "<kbd>Ctrl K</kbd>");
  assertStringIncludes(palette, '<dialog class="palette_');
  assertStringIncludes(palette, 'data-shortcut="k"');
  assertStringIncludes(palette, 'role="combobox"');
  assertStringIncludes(palette, 'role="group" aria-label="Pages"');
  assertStringIncludes(
    palette,
    'href="/stock" tabindex="-1" data-command="" data-keywords="inventory"',
  );
  assertStringIncludes(palette, "<small>G S</small>");
  assertStringIncludes(palette, 'type="button" role="option"');
  assertStringIncludes(palette, "No results.</p>");
  assertEquals(linkOf(trigger), linkOf(palette));
  const quiet = component.instance();
  const unbound = await render(<quiet.Palette shortcut={false} />);
  assertEquals(unbound.includes("data-shortcut"), false);
});

Deno.test("the library combobox submits the option chosen", async () => {
  const { component } = await imports(ComboboxSignalComponent);
  const dentist = component.instance();
  const input = await render(
    <dentist.Input
      name="dentist"
      label="Dentist"
      value="7"
      text="Dr Amy Shah"
      required
    >
      <dentist.Option value={7}>Dr Amy Shah</dentist.Option>
      <dentist.Option value="9" keywords="hygiene" disabled>Sam</dentist.Option>
    </dentist.Input>,
  );
  const value = await render(<dentist.Value />);
  assertStringIncludes(input, 'role="combobox" aria-label="Dentist"');
  assertStringIncludes(input, 'value="Dr Amy Shah" required=""');
  // The hidden input submits the chosen value, not the text.
  assertStringIncludes(
    input,
    '<input type="hidden" name="dentist" value="7"/>',
  );
  const list = /aria-controls="([^"]+)"/.exec(input)?.[1];
  assertStringIncludes(input, `<div role="listbox" id="${list}"`);
  assertStringIncludes(input, 'data-value="7" aria-selected="false"');
  assertStringIncludes(input, 'data-keywords="hygiene"');
  assertStringIncludes(input, 'aria-disabled="true"');
  assertStringIncludes(input, "No matches.</p>");
  assertStringIncludes(value, "<output");
  assertEquals(linkOf(value), linkOf(input));
  const remote = component.instance();
  const fetched = await render(<remote.Input source="/patients/search" />);
  assertStringIncludes(fetched, 'data-source="/patients/search"');
  assertEquals(linkOf(fetched) === linkOf(input), false);
});

Deno.test("the library tooltip's trigger and tip share one state", async () => {
  const { component } = await imports(TooltipSignalComponent);
  const save = component.instance();
  const trigger = await render(
    <save.Trigger>
      <button type="button">Save</button>
    </save.Trigger>,
  );
  const tip = await render(<save.Tip side="bottom">Ctrl S</save.Tip>);
  assertStringIncludes(trigger, '<button type="button">Save</button>');
  assertStringIncludes(trigger, 'tt-handler-pointerenter="');
  assertStringIncludes(tip, 'popover="manual" role="tooltip"');
  assertStringIncludes(tip, 'data-side="bottom" data-open-delay="500"');
  assertEquals(linkOf(tip), linkOf(trigger));
  const patient = component.instance();
  const card = await render(<patient.Card delay={200}>Ann Lee</patient.Card>);
  assertEquals(card.includes('role="tooltip"'), false);
  assertStringIncludes(card, 'data-open-delay="200" data-close-delay="300"');
  assertStringIncludes(card, 'tt-handler-pointerleave="');
});

Deno.test("the library steps show one step of a form at a time", async () => {
  const { component } = await imports(StepsSignalComponent);
  const signup = component.instance();
  const progress = await render(<signup.Progress />);
  const step = await render(
    <signup.Step title="Contact" current>
      <input name="email" type="email" required />
    </signup.Step>,
  );
  const controls = await render(
    <div>
      <signup.Back />
      <signup.Next />
      <signup.Submit>Register</signup.Submit>
      <signup.Status />
    </div>,
  );
  assertStringIncludes(progress, '<ol class="progress_');
  assertStringIncludes(step, '<fieldset class="step_');
  assertStringIncludes(step, 'data-title="Contact" data-current=""');
  assertStringIncludes(step, "<legend>Contact</legend>");
  assertStringIncludes(step, 'tt-handler-disconnect="');
  // Before the steps connect, only the form's own submit is usable.
  assertStringIncludes(controls, 'disabled="" tt-disabled-signal="');
  assertStringIncludes(controls, 'hidden="" tt-hidden-signal="');
  assertStringIncludes(
    controls,
    '<button type="submit" class="submit_',
  );
  assertEquals(/type="submit"[^>]* hidden=""/.test(controls), false);
  for (const part of [step, controls]) {
    assertEquals(linkOf(part), linkOf(progress));
  }
});

Deno.test("the library carousel's controls steer one track", async () => {
  const { component } = await imports(CarouselSignalComponent);
  const photos = component.instance();
  const track = await render(
    <photos.Track label="Photos" loop autoplay={4000}>
      <photos.Slide>A</photos.Slide>
      <photos.Slide label="Lower arch">B</photos.Slide>
    </photos.Track>,
  );
  const controls = await render(
    <div>
      <photos.Previous />
      <photos.Dots />
      <photos.Next />
      <photos.Status />
      <photos.Play />
    </div>,
  );
  assertStringIncludes(track, 'role="region" aria-roledescription="carousel"');
  assertStringIncludes(track, 'data-loop="" data-autoplay="4000"');
  assertStringIncludes(track, 'tt-handler-scroll="');
  assertStringIncludes(track, 'aria-roledescription="slide"');
  assertStringIncludes(track, 'data-slide="" data-label="Lower arch"');
  assertStringIncludes(controls, 'aria-label="Previous slide" disabled=""');
  assertStringIncludes(controls, 'aria-label="Choose a slide"');
  assertStringIncludes(controls, ">Play</button>");
  // Placed after the track, the controls catch up with its signals as they
  // connect.
  assertEquals(controls.match(/signals_\w+\.fireSelfSignal/g)?.length, 4);
  assertEquals(new Set(controls.match(/tt-link="[^"]+"/g)).size, 1);
  assertEquals(linkOf(controls), linkOf(track));
});
