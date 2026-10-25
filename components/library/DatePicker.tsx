/**
 * A date or week input, with any of: buttons that step it, a today button and
 * the name of its day. Each part sits wherever the page puts it.
 *
 * ```tsx
 * const { component } = await tiny.imports(DatePickerSignalComponent);
 * const visitDate = component.instance();
 *
 * <visitDate.Step by={-1} unit="week">«</visitDate.Step>
 * <visitDate.Step by={-1} />
 * <visitDate.Weekday value={date} />
 * <visitDate.DateInput name="date" value={date} skipWeekends onChange={fn.submit} />
 * <visitDate.Today />
 * <visitDate.Step by={1} />
 * <visitDate.Step by={1} unit="week">»</visitDate.Step>
 * ```
 *
 * A step or today sets the input as an edit would, firing `input` and
 * `change`, so a form submitting on `change` submits it too.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { type HandlerReference, tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import type { SignalEvent } from "../../handlers/signals.ts";

/**
 * @internal Date arithmetic on input values, shared by the signals, the
 * handlers and the server's first render. Plain UTC dates, so no time zone
 * moves a day.
 */
export const dateFunctions = {
  /**
   * The date `days` after `value` (a date input's `2026-10-25` or a week
   * input's `2026-W43`; today when empty), written as an input of `type`
   * takes it. With `skipWeekends`, a step landing on a Saturday or Sunday
   * carries on in its direction to the nearest weekday.
   */
  moveDate(
    value: string,
    days: number,
    type: string,
    skipWeekends = false,
  ): string {
    const dayMs = 86_400_000;
    const week = /^(\d{4})-W(\d{2})$/.exec(value);
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const now = new Date();
    let time = week
      // 4 January is always in ISO week 1.
      ? Date.UTC(Number(week[1]), 0, 4)
      : day
      ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
      : Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    if (week) {
      // The Monday of week 1, then of the week named.
      const monday = (new Date(time).getUTCDay() + 6) % 7;
      time += ((Number(week[2]) - 1) * 7 - monday) * dayMs;
    }
    time += days * dayMs;
    if (skipWeekends && days !== 0 && type !== "week") {
      while ([0, 6].includes(new Date(time).getUTCDay())) {
        time += Math.sign(days) * dayMs;
      }
    }
    const date = new Date(time);
    if (type !== "week") return date.toISOString().slice(0, 10);
    // A week belongs to the year its Thursday falls in.
    const thursday = time + (3 - (date.getUTCDay() + 6) % 7) * dayMs;
    const year = new Date(thursday).getUTCFullYear();
    const number = 1 +
      Math.floor((thursday - Date.UTC(year, 0, 1)) / dayMs / 7);
    return `${year}-W${String(number).padStart(2, "0")}`;
  },
  /** The day of the week of a date input's `value`; empty for any other. */
  weekday(value: string): string {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return day
      ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])))
        .toLocaleDateString("en", { weekday: "long", timeZone: "UTC" })
      : "";
  },
};

const dateTools = new tiny.Handlers(import.meta.url, dateFunctions);

/**
 * One date per instance. The input writes `date` as it is edited and shows it
 * when a button sets it; `type` and `skipWeekends` are the input's own, taken
 * when it connects, so the buttons step as it does wherever they sit.
 */
const datePickerSignals = new tiny.Signals(import.meta.url, async () => {
  const { fn } = await tiny.imports(dateTools);
  return ({ Signal, Computed, perInstance }) =>
    perInstance(() => {
      const date = new Signal("");
      return {
        date,
        type: new Signal("date"),
        skipWeekends: new Signal(false),
        weekday: new Computed(() => fn.weekday(date.value), [date]),
      };
    });
});

const datePickerHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(dateTools, datePickerSignals);
  return {
    /** Takes the input's value, type and weekend rule into its instance. */
    adoptInput: function (this: HTMLInputElement) {
      signal.type.forInstance(this).value = this.type;
      signal.skipWeekends.forInstance(this).value = this.hasAttribute(
        "data-skip-weekends",
      );
      signal.date.forInstance(this).value = this.value;
    },
    /** Shows a date set elsewhere, firing `input` and `change` as an edit would. */
    showDate: function (this: HTMLInputElement, event: SignalEvent) {
      const value = String(event.signal.value ?? "");
      if (this.value === value) return;
      this.value = value;
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    },
    /**
     * Moves the date by the button's `data-by`, in its `data-unit` or else
     * the input's own (a day, or a week for a week input). An empty input
     * stays empty.
     */
    step: function (this: HTMLButtonElement) {
      const date = signal.date.forInstance(this);
      if (!date.value) return;
      const type = signal.type.forInstance(this).value;
      const unit = this.dataset.unit ?? (type === "week" ? "week" : "day");
      date.value = fn.moveDate(
        date.value,
        Number(this.dataset.by) * (unit === "week" ? 7 : 1),
        type,
        signal.skipWeekends.forInstance(this).value,
      );
    },
    /** Sets the date to today, or this week for a week input. */
    today: function (this: HTMLButtonElement) {
      signal.date.forInstance(this).value = fn.moveDate(
        "",
        0,
        signal.type.forInstance(this).value,
      );
    },
  };
});

const datePickerStyles = new tiny.Styles(import.meta.url, {
  // The buttons need the page's script, so they stay hidden without it.
  dateButton: css`
    @media (scripting: none) {
      display: none;
    }
  `,
});

/**
 * `DateInput` is the input itself: a form field named `name`. `Weekday`
 * names its day, `Step` moves it by `by` days or weeks and `Today` sets it to
 * today. `DateInput` and `Weekday` expose `signal.date` and `signal.weekday`.
 */
export const DatePickerSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      datePickerSignals,
      datePickerHandlers,
      datePickerStyles,
    );
    return {
      DateInput: instanced((props: {
        name: string;
        value?: string;
        /** A `week` input steps a week at a time. */
        type?: "date" | "week";
        /** Steps over Saturday and Sunday; the picker can still choose them. */
        skipWeekends?: boolean;
        /** Runs on every change, from an edit, a step or today alike. */
        onChange?:
          | HandlerReference<string, (event: Event) => unknown>
          | readonly HandlerReference<string, (event: Event) => unknown>[];
      }) => (
        <input
          type={props.type ?? "date"}
          name={props.name}
          value={props.value ?? ""}
          data-skip-weekends={props.skipWeekends || undefined}
          onConnect={[signal.date, fn.adoptInput]}
          onSignal={fn.showDate}
          onInput={signal.date}
          onChange={props.onChange}
        />
      ), [signal.date, signal.weekday]),
      Weekday: instanced(
        (props: {
          /** The input's date, for the name shown before the script runs. */
          value?: string;
        }) => (
          <output>
            {signal.weekday.withInitial(
              dateFunctions.weekday(props.value ?? ""),
            )}
          </output>
        ),
        [signal.weekday],
      ),
      Step: instanced((props: {
        /** How far, back when negative. */
        by: number;
        /** Days or weeks; by default the input's own unit. */
        unit?: "day" | "week";
        /** Its accessible name; by default "Previous day", "Next 2 weeks"... */
        label?: string;
        /** What it shows; by default ‹ or ›. */
        children?: unknown;
      }) => {
        const count = Math.abs(props.by);
        const direction = props.by < 0 ? "Previous" : "Next";
        const label = props.label ??
          (props.unit
            ? `${direction} ${
              count === 1 ? props.unit : `${count} ${props.unit}s`
            }`
            : count === 1
            ? direction
            : `${props.by < 0 ? "Back" : "Forward"} ${count}`);
        return (
          <button
            type="button"
            class={styled.dateButton}
            aria-label={label}
            title={label}
            data-by={props.by}
            data-unit={props.unit}
            onClick={fn.step}
          >
            {props.children ?? (props.by < 0 ? "‹" : "›")}
          </button>
        );
      }),
      Today: instanced((props: { children?: unknown }) => (
        <button type="button" class={styled.dateButton} onClick={fn.today}>
          {props.children ?? "Today"}
        </button>
      )),
    };
  },
);
