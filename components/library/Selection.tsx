/**
 * Row selection: a checkbox per row, one selecting them all, a count of the
 * chosen and actions enabled while any are. Each part sits wherever the page
 * puts it.
 *
 * ```tsx
 * const { component } = await tiny.imports(SelectionSignalComponent);
 * const picked = component.instance();
 *
 * <form method="post" action="/recalls/send" id="recalls">
 *   <picked.Bar>
 *     <picked.Count />
 *     <picked.Action>Send recall</picked.Action>
 *     <picked.Clear />
 *   </picked.Bar>
 * </form>
 * <table>
 *   <thead><tr><th><picked.SelectAll /></th><th>Patient</th></tr></thead>
 *   <tbody>
 *     {patients.map((patient) => (
 *       <tr>
 *         <td>
 *           <picked.Checkbox name="ids" form="recalls" value={patient.id}
 *             label={patient.name} />
 *         </td>
 *         <td>{patient.name}</td>
 *       </tr>
 *     ))}
 *   </tbody>
 * </table>
 * ```
 *
 * The checkboxes are real ones, so a form they belong to (by nesting or
 * `form`) submits the chosen values under their `name`, script or not.
 * Shift-click selects or clears every row between the last one clicked and
 * this one. A row holding a checkbox (its closest `tr`, `li` or
 * `[data-selectable]`) carries `data-selected` while chosen, for the page to
 * style. Rows that leave the page leave the selection.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { signalTools } from "../../handlers/signals.ts";

/**
 * Per instance: every checkbox's value, the chosen ones, and the last one
 * clicked, where a shift-click's range starts.
 */
const selectionSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed, perInstance }) =>
    perInstance(() => {
      const values = new Signal<string[]>([]);
      const selected = new Signal<string[]>([]);
      return {
        values,
        selected,
        anchor: new Signal(""),
        count: new Computed(() => selected.value.length, [selected]),
        /** Whether nothing is chosen. */
        none: new Computed(() => selected.value.length === 0, [selected]),
        /** "3 of 12 selected" while any are; empty otherwise. */
        summary: new Computed(
          () =>
            selected.value.length
              ? `${selected.value.length} of ${values.value.length} selected`
              : "",
          [selected, values],
        ),
      };
    }),
);

const selectionHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(selectionSignals);
  return {
    /** Lists the checkbox's value, chosen if it was rendered checked. */
    joinSelection: function (this: HTMLInputElement) {
      const values = signal.values.forInstance(this);
      if (!values.value.includes(this.value)) {
        values.value = [...values.value, this.value];
      }
      const selected = signal.selected.forInstance(this);
      if (this.checked && !selected.value.includes(this.value)) {
        selected.value = [...selected.value, this.value];
      }
      this.closest("tr, li, [data-selectable]")
        ?.toggleAttribute("data-selected", this.checked);
    },
    /** Drops a checkbox leaving the page from the list and the selection. */
    leaveSelection: function (this: HTMLInputElement) {
      const values = signal.values.forInstance(this);
      const selected = signal.selected.forInstance(this);
      values.value = values.value.filter((value) => value !== this.value);
      selected.value = selected.value.filter((value) => value !== this.value);
    },
    /**
     * Chooses or drops the checkbox's value, and with Shift held, every
     * value between the last one clicked and it, as the page orders them
     * (checkboxes may connect in any order, or move).
     */
    toggleSelected: function (this: HTMLInputElement, event: MouseEvent) {
      const link = this.getAttribute("tt-link");
      const values = [
        ...document.querySelectorAll<HTMLInputElement>(
          "input[data-selection-item]",
        ),
      ].filter((box) => box.getAttribute("tt-link") === link)
        .map((box) => box.value);
      const anchor = signal.anchor.forInstance(this);
      const selected = signal.selected.forInstance(this);
      const from = values.indexOf(anchor.value);
      const to = values.indexOf(this.value);
      const range = event.shiftKey && from >= 0 && to >= 0
        ? values.slice(Math.min(from, to), Math.max(from, to) + 1)
        : [this.value];
      const rest = selected.value.filter((value) => !range.includes(value));
      selected.value = this.checked ? [...rest, ...range] : rest;
      anchor.value = this.value;
    },
    /** Checks the box, and marks its row, while its value is chosen. */
    showSelected: function (this: HTMLInputElement) {
      this.checked = signal.selected.forInstance(this).value.includes(
        this.value,
      );
      this.closest("tr, li, [data-selectable]")
        ?.toggleAttribute("data-selected", this.checked);
    },
    /** Chooses every value, or none once all are chosen. */
    toggleAll: function (this: HTMLInputElement) {
      const values = signal.values.forInstance(this).value;
      const selected = signal.selected.forInstance(this);
      const all = values.length > 0 &&
        values.every((value) => selected.value.includes(value));
      selected.value = all ? [] : [...values];
    },
    /** Checked while all are chosen, and mixed while some are. */
    showAll: function (this: HTMLInputElement) {
      const values = signal.values.forInstance(this).value;
      const selected = signal.selected.forInstance(this).value;
      const chosen = values.filter((value) => selected.includes(value)).length;
      this.checked = values.length > 0 && chosen === values.length;
      this.indeterminate = chosen > 0 && chosen < values.length;
      this.disabled = values.length === 0;
    },
    clearSelection: function (this: HTMLButtonElement) {
      signal.selected.forInstance(this).value = [];
      signal.anchor.forInstance(this).value = "";
    },
  };
});

const selectionStyles = new tiny.Styles(import.meta.url, {
  checkbox: css`
    width: 1rem;
    height: 1rem;
    margin: 0;
    accent-color: var(--selection-accent, oklch(50.8% 0.105 165.6));
    cursor: pointer;
  `,
  bar: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--selection-border, light-dark(oklch(90.5% 0.089 164.2), oklch(29.5% 0.067 164.2)));
    border-radius: 8px;
    background: var(--selection-surface, light-dark(oklch(97.9% 0.021 166.1), oklch(22.1% 0.016 166.1)));

    &[hidden] {
      display: none;
    }
    > output {
      margin-right: auto;
      font-weight: 600;
    }
  `,
});

/**
 * `Checkbox` chooses its row's `value`, `SelectAll` chooses every row, `Count`
 * shows "3 of 12 selected", `Bar` shows its children only while any are
 * chosen, `Action` is a button enabled only then, and `Clear` drops them
 * all. Every part exposes `signal.selected`, the chosen values, and
 * `signal.count`.
 */
export const SelectionSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      selectionSignals,
      selectionHandlers,
      selectionStyles,
      signalTools,
    );
    // Parts placed after checkboxes rendered `checked` connect once those
    // have changed these signals, so each catches up with `fireSelfSignal`.
    const exposed = [signal.selected, signal.count] as const;
    return {
      Checkbox: instanced((props: {
        value: string | number;
        /** Names the checkbox, as "Select <label>". */
        label?: string;
        /** Its form field name, so a form submits the chosen values. */
        name?: string;
        /** The id of a form it belongs to, from outside it. */
        form?: string;
        /** Chosen as the page loads. */
        checked?: boolean;
      }) => (
        <input
          type="checkbox"
          class={styled.checkbox}
          value={String(props.value)}
          name={props.name}
          form={props.form}
          checked={props.checked}
          aria-label={props.label ? `Select ${props.label}` : "Select"}
          data-selection-item
          onConnect={[signal.selected, fn.joinSelection]}
          onDisconnect={fn.leaveSelection}
          onSignal={fn.showSelected}
          onClick={fn.toggleSelected}
        />
      ), exposed),
      SelectAll: instanced((props: { label?: string }) => (
        <input
          type="checkbox"
          class={styled.checkbox}
          aria-label={props.label ?? "Select all"}
          onConnect={[signal.selected, signal.values, fn.showAll]}
          onSignal={fn.showAll}
          onClick={fn.toggleAll}
        />
      ), exposed),
      Count: instanced(
        <output
          aria-live="polite"
          onConnect={[signal.summary, fn.fireSelfSignal]}
          onSignal={fn.setTextContent}
        />,
        exposed,
      ),
      Bar: instanced((props: { label?: string; children?: unknown }) => (
        <div
          role="toolbar"
          class={styled.bar}
          aria-label={props.label ?? "Selection actions"}
          hidden={signal.none}
          onConnect={[signal.none, fn.fireSelfSignal]}
        >
          {props.children}
        </div>
      ), exposed),
      Action: instanced((props: {
        /** `submit` by default, sending the chosen rows' form. */
        type?: "submit" | "button";
        name?: string;
        value?: string;
        form?: string;
        formaction?: string;
        children?: unknown;
      }) => (
        <button
          type={props.type ?? "submit"}
          name={props.name}
          value={props.value}
          form={props.form}
          formaction={props.formaction}
          disabled={signal.none}
          onConnect={[signal.none, fn.fireSelfSignal]}
        >
          {props.children}
        </button>
      ), exposed),
      Clear: instanced(
        (props: { children?: unknown }) => (
          <button type="button" onClick={fn.clearSelection}>
            {props.children ?? "Clear"}
          </button>
        ),
        exposed,
      ),
    };
  },
);
