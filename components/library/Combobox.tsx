/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A combobox: a text box suggesting options as you type, from its own list or
 * from the server, choosing one with the mouse or the keyboard.
 *
 * ```tsx
 * const { component } = await tiny.imports(ComboboxSignalComponent);
 * const dentist = component.instance();
 *
 * <dentist.Input name="dentist" label="Dentist" required>
 *   <dentist.Option value="7">Dr Amy Shah</dentist.Option>
 *   <dentist.Option value="9" keywords="hygiene">Sam Reid</dentist.Option>
 * </dentist.Input>
 * <p>Booking with <dentist.Value /></p>
 * ```
 *
 * Typing keeps the options holding every word typed, in their text or
 * `keywords`, ignoring case and accents. With a `source` it fetches them
 * instead, as `<source>?q=<text>`, expecting the HTML of `Option`s back, so
 * an endpoint renders them with this component as a page would. ↑ and ↓ move
 * between options, Enter chooses one and Escape closes the list, or clears
 * the box once closed.
 *
 * The chosen option's value is submitted under `name` by a hidden input, so
 * the box takes part in its form, client routing or not. Text matching no
 * option leaves nothing chosen and the box invalid, so a form will not
 * submit it.
 *
 * Colours come from custom properties a caller may set on the box or any
 * ancestor: `--combobox-surface`, `--combobox-border`, `--combobox-text`,
 * `--combobox-muted` and `--combobox-active`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h, type JSX } from "../../jsx-runtime.ts";
import {
  type InstancedComponent,
  type InstanceSignals,
  type Signal,
  type SignalComponent,
  tiny,
} from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { signalTools } from "../../handlers/signals.ts";

/**
 * Per instance: the chosen option's value and text, and whether the list is
 * open.
 */
const comboboxSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({
      value: new Signal(""),
      label: new Signal(""),
      open: new Signal<boolean>(false),
    })),
);

/** The signals the combobox's parts expose. */
type ComboboxExposed = InstanceSignals<{
  value: Signal<string>;
  label: Signal<string>;
}>;

/** Props for the combobox's `Input`. */
type InputProps = {
  /** The name the chosen value is submitted under. */
  name?: string;
  /** Names the box to assistive technology. */
  label?: string;
  placeholder?: string;
  /** The value chosen as the page loads, with `text` its option's text. */
  value?: string;
  text?: string;
  /**
   * A URL answering `?q=<text>` with the HTML of `Option`s, fetched
   * as the text changes instead of filtering the box's own options.
   */
  source?: string;
  /** Shown while no option matches; default "No matches." */
  empty?: unknown;
  /** Why text matching no option is invalid. */
  invalid?: string;
  required?: boolean;
  /** The form it belongs to, if it sits outside it. */
  form?: string;
  /** The text box's id, for a `<label for>` of the page's own. */
  id?: string;
  children?: unknown;
};

/** Props for a combobox `Option`. */
type OptionProps = {
  value: string | number;
  /** More words it matches, besides its text. */
  keywords?: string;
  /** The text put in the box when chosen; by default its own text. */
  label?: string;
  disabled?: boolean;
  children?: unknown;
};

/** Helpers the handlers share, called through `fn`. */
const comboboxTools = new tiny.Handlers(import.meta.url, {
  /** The options the text leaves showing. */
  shownOptions(box: HTMLElement): HTMLElement[] {
    return [...box.querySelectorAll<HTMLElement>('[role="option"]')]
      .filter((option) => !option.hidden);
  },
  /** The text an option puts in the box. */
  optionText(option: Element): string {
    return (option as HTMLElement).dataset.label ??
      option.textContent?.trim() ?? "";
  },
  /** Marks `option` as the one Enter chooses, scrolling it into view. */
  activate(box: HTMLElement, option: HTMLElement | undefined): void {
    const input = box.querySelector<HTMLInputElement>('[role="combobox"]')!;
    for (const other of box.querySelectorAll('[role="option"]')) {
      other.toggleAttribute("data-active", other === option);
    }
    if (!option) return input.removeAttribute("aria-activedescendant");
    option.id ||= `tiny-option-${Math.random().toString(36).slice(2, 10)}`;
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  },
  /** Shows the "nothing matches" note while no option is shown. */
  noteEmpty(box: HTMLElement, shown: number): void {
    const empty = box.querySelector<HTMLElement>("[data-empty]");
    if (empty) empty.hidden = shown > 0;
  },
});

const comboboxHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(comboboxSignals, comboboxTools);
  return {
    /** Takes the value and text the box was rendered with. */
    adoptCombobox: function (this: HTMLElement) {
      const hidden = this.querySelector<HTMLInputElement>('[type="hidden"]')!;
      const input = this.querySelector<HTMLInputElement>('[role="combobox"]')!;
      signal.value.forInstance(this).value = hidden.value;
      signal.label.forInstance(this).value = hidden.value ? input.value : "";
    },
    /**
     * Writes the choice into the hidden input, firing `change` for the page,
     * and leaves text matching no option invalid.
     */
    showChoice: function (this: HTMLElement) {
      const value = signal.value.forInstance(this).value;
      const label = signal.label.forInstance(this).value;
      const hidden = this.querySelector<HTMLInputElement>('[type="hidden"]')!;
      const input = this.querySelector<HTMLInputElement>('[role="combobox"]')!;
      if (value && label && input.value !== label) input.value = label;
      if (hidden.value !== value) {
        hidden.value = value;
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }
      for (const option of this.querySelectorAll('[role="option"]')) {
        const chosen = Boolean(value) &&
          (option as HTMLElement).dataset.value === value;
        option.setAttribute("aria-selected", String(chosen));
      }
      input.setCustomValidity(
        input.value && !value ? this.dataset.invalid ?? "" : "",
      );
    },
    /** Opens or closes the list as `open` changes. */
    showList: function (this: HTMLElement) {
      const open = signal.open.forInstance(this).value;
      this.querySelector<HTMLElement>('[role="listbox"]')!.hidden = !open;
      this.querySelector('[role="combobox"]')!
        .setAttribute("aria-expanded", String(open));
      if (!open) fn.activate(this, undefined);
    },
    /**
     * Drops the choice once the text changes, then filters the options, or
     * fetches them from the `source`.
     */
    typeInCombobox: function (
      this: HTMLElement & {
        comboTimer?: ReturnType<typeof setTimeout>;
        comboFetch?: AbortController;
      },
      event: Event,
    ) {
      const input = event.target as HTMLInputElement;
      if (input.getAttribute("role") !== "combobox") return;
      if (input.value !== signal.label.forInstance(this).value) {
        signal.value.forInstance(this).value = "";
        signal.label.forInstance(this).value = "";
      }
      signal.open.forInstance(this).value = true;
      const source = this.dataset.source;
      if (!source) {
        // Lower case, without accents, so "Zoe" matches "Zoë".
        const fold = (text: string) =>
          text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
        const words = fold(input.value).split(/\s+/).filter(Boolean);
        for (
          const option of this.querySelectorAll<HTMLElement>('[role="option"]')
        ) {
          const text = fold(
            `${option.textContent} ${option.dataset.keywords ?? ""}`,
          );
          option.hidden = !words.every((word) => text.includes(word));
        }
        const shown = fn.shownOptions(this);
        fn.noteEmpty(this, shown.length);
        fn.activate(this, input.value ? shown[0] : undefined);
        return;
      }
      clearTimeout(this.comboTimer);
      this.comboTimer = setTimeout(async () => {
        this.comboFetch?.abort();
        const request = this.comboFetch = new AbortController();
        const url = new URL(source, location.href);
        url.searchParams.set("q", input.value);
        try {
          const response = await fetch(url, { signal: request.signal });
          const html = await response.text();
          const list = this.querySelector<HTMLElement>('[role="listbox"]')!;
          for (const option of list.querySelectorAll('[role="option"]')) {
            option.remove();
          }
          list.querySelector("[data-empty]")!
            .insertAdjacentHTML("beforebegin", html);
          // Re-marks the chosen option among the new ones.
          const value = signal.value.forInstance(this).value;
          for (const option of list.querySelectorAll('[role="option"]')) {
            option.setAttribute(
              "aria-selected",
              String((option as HTMLElement).dataset.value === value),
            );
          }
          const shown = fn.shownOptions(this);
          fn.noteEmpty(this, shown.length);
          fn.activate(this, input.value ? shown[0] : undefined);
        } catch (error) {
          if ((error as Error).name !== "AbortError") throw error;
        }
      }, 150);
    },
    /** Moves through the options, chooses one, or closes the list. */
    keyInCombobox: function (this: HTMLElement, event: KeyboardEvent) {
      const open = signal.open.forInstance(this);
      const shown = fn.shownOptions(this);
      const current = shown.findIndex((option) =>
        option.hasAttribute("data-active")
      );
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open.value) {
          open.value = true;
          fn.noteEmpty(this, shown.length);
        }
        if (!shown.length) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = current < 0 && step < 0 ? -1 : current + step;
        fn.activate(this, shown.at(next % shown.length));
      } else if (event.key === "Enter" && open.value && !event.isComposing) {
        // Keeps the form from submitting while the list is open.
        event.preventDefault();
        if (current >= 0) shown[current].click();
        else open.value = false;
      } else if (event.key === "Escape") {
        if (open.value) {
          event.preventDefault();
          open.value = false;
        } else {
          const input = event.target as HTMLInputElement;
          input.value = "";
          signal.value.forInstance(this).value = "";
          signal.label.forInstance(this).value = "";
        }
      }
    },
    /** Opens or closes the list on a click in the box. */
    clickCombobox: function (this: HTMLElement, event: MouseEvent) {
      const target = event.target as Element;
      if (target.getAttribute("role") !== "combobox") return;
      const open = signal.open.forInstance(this);
      open.value = !open.value;
      if (open.value) fn.noteEmpty(this, fn.shownOptions(this).length);
    },
    /** Chooses the option clicked. */
    chooseOption: function (this: HTMLElement, event: MouseEvent) {
      // A box inside a <label> would otherwise pass the click on to the
      // text box, reopening the list.
      event.preventDefault();
      const option = (event.target as Element).closest?.('[role="option"]') as
        | HTMLElement
        | null;
      if (!option || option.getAttribute("aria-disabled") === "true") return;
      signal.label.forInstance(this).value = fn.optionText(option);
      signal.value.forInstance(this).value = option.dataset.value ?? "";
      signal.open.forInstance(this).value = false;
      this.closest("[data-combobox]")
        ?.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    },
    /** Keeps focus in the box while an option is clicked. */
    holdFocus: function (event: PointerEvent) {
      event.preventDefault();
    },
    /**
     * Closes the list as focus leaves, choosing the option the text names
     * exactly, if there is one.
     */
    leaveCombobox: function (this: HTMLInputElement) {
      const box = this.closest<HTMLElement>("[data-combobox]")!;
      signal.open.forInstance(this).value = false;
      if (!this.value || signal.value.forInstance(this).value) return;
      const text = this.value.trim().toLowerCase();
      const match = [...box.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => fn.optionText(option).toLowerCase() === text);
      if (!match) return;
      signal.label.forInstance(this).value = fn.optionText(match);
      signal.value.forInstance(this).value = match.dataset.value ?? "";
    },
  };
});

const comboboxStyles = new tiny.Styles(import.meta.url, {
  combobox: css`
    position: relative;
    display: inline-block;
    min-width: 16rem;

    > input {
      box-sizing: border-box;
      width: 100%;
      padding: 0.45rem 2rem 0.45rem 0.6rem;
      border: 1px solid var(--combobox-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
      border-radius: 6px;
      background: var(--combobox-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)))
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' fill='none' stroke='%236b7280' stroke-width='1.5'/%3E%3C/svg%3E")
        no-repeat right 0.6rem center;
      color: var(--combobox-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
      font: inherit;
    }
    > input:focus-visible {
      outline: 2px solid var(--combobox-active-border, oklch(50.8% 0.105 165.6));
      outline-offset: -1px;
    }
    > input:user-invalid {
      border-color: oklch(50.5% 0.19 27.5);
    }
    > [role="listbox"] {
      position: absolute;
      z-index: 10;
      top: calc(100% + 0.25rem);
      left: 0;
      right: 0;
      box-sizing: border-box;
      max-height: 15rem;
      margin: 0;
      padding: 0.25rem;
      overflow-y: auto;
      border: 1px solid var(--combobox-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
      border-radius: 8px;
      background: var(--combobox-surface, light-dark(oklch(100% 0 0), oklch(20% 0 0)));
      color: var(--combobox-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
      box-shadow: 0 8px 24px oklch(21% 0.032 264.7 / 0.16);
    }
    [role="option"] {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.6rem;
      border-radius: 4px;
      cursor: pointer;
    }
    [role="option"][data-active] {
      background: var(--combobox-active, light-dark(oklch(97.9% 0.021 166.1), oklch(22.1% 0.016 166.1)));
    }
    [role="option"][aria-selected="true"] {
      font-weight: 600;
    }
    [role="option"][aria-selected="true"]::after {
      content: "✓";
      margin-left: auto;
    }
    [role="option"][aria-disabled="true"] {
      opacity: 0.5;
      cursor: default;
    }
    [role="option"] small,
    [data-empty] {
      color: var(--combobox-muted, light-dark(oklch(55.1% 0.023 264.4), oklch(64.9% 0.023 264.4)));
    }
    [data-empty] {
      margin: 0;
      padding: 0.75rem;
      text-align: center;
    }
    [hidden] {
      display: none !important;
    }
  `,
});

/**
 * `Input` is the text box, holding its `Option`s (or fetching them from its
 * `source`). `Value` shows the chosen option's text. Both expose
 * `signal.value`, the chosen option's value, and `signal.label`, its text.
 */
export const ComboboxSignalComponent: SignalComponent<{
  Input: InstancedComponent<ComboboxExposed, InputProps>;
  Value: InstancedComponent<ComboboxExposed, Record<never, never>>;
  Option: (props: OptionProps) => JSX.Element;
}> = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      comboboxSignals,
      comboboxHandlers,
      comboboxStyles,
      signalTools,
    );
    return {
      Input: instanced((props: InputProps) => {
        const list = `tiny-listbox-${crypto.randomUUID().slice(0, 8)}`;
        return (
          <div
            class={styled.combobox}
            data-combobox=""
            data-source={props.source}
            data-invalid={props.invalid ?? "Choose one of the options."}
            onConnect={[
              signal.value,
              signal.label,
              signal.open,
              fn.adoptCombobox,
            ]}
            onSignal={[fn.showChoice, fn.showList]}
            onInput={fn.typeInCombobox}
            onKeyDown={fn.keyInCombobox}
            onClick={fn.clickCombobox}
          >
            <input
              type="text"
              id={props.id}
              role="combobox"
              aria-label={props.label}
              aria-autocomplete="list"
              aria-expanded="false"
              aria-controls={list}
              autocomplete="off"
              placeholder={props.placeholder}
              value={props.text ?? ""}
              required={props.required}
              form={props.form}
              onBlur={fn.leaveCombobox}
            />
            <input
              type="hidden"
              name={props.name}
              value={props.value ?? ""}
              form={props.form}
            />
            <div
              role="listbox"
              id={list}
              aria-label={props.label}
              hidden
              onPointerDown={fn.holdFocus}
              onClick={fn.chooseOption}
            >
              {props.children}
              <p data-empty hidden>{props.empty ?? "No matches."}</p>
            </div>
          </div>
        );
      }, [signal.value, signal.label]),
      Value: instanced(
        () => (
          <output
            onConnect={[signal.label, fn.fireSelfSignal]}
            onSignal={fn.setTextContent}
          />
        ),
        [signal.value, signal.label],
      ),
      Option: (props: OptionProps) => (
        <div
          role="option"
          data-value={String(props.value)}
          data-keywords={props.keywords}
          data-label={props.label}
          aria-selected="false"
          aria-disabled={props.disabled ? "true" : undefined}
        >
          {props.children ?? props.label ?? props.value}
        </div>
      ),
    };
  },
);
