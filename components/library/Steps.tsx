/**
 * A multi-step form: one form shown a step at a time, each step checked
 * before the next, with a progress list and Back and Next buttons.
 *
 * ```tsx
 * const { component } = await tiny.imports(StepsSignalComponent);
 * const signup = component.instance();
 *
 * <form method="post" action="/patients">
 *   <signup.Progress />
 *   <signup.Step title="Details">
 *     <input name="name" required />
 *   </signup.Step>
 *   <signup.Step title="Contact">
 *     <input name="email" type="email" required />
 *   </signup.Step>
 *   <signup.Back /> <signup.Next /> <signup.Submit>Register</signup.Submit>
 * </form>
 * ```
 *
 * Next, or Enter in a field, moves on only once every field of the step is
 * valid, by the form's own rules (`required`, `pattern`, `type` and so on),
 * reporting the first that is not. Back, and the progress list's finished
 * steps, go back without checking. Submit checks every step, showing the
 * first with a field to fix, so the form only sends once all are valid.
 *
 * It is all one form, so every step's fields submit together, with or
 * without client routing. Without the page's script every step shows at
 * once, as an ordinary long form.
 *
 * Colours come from custom properties a caller may set on any ancestor:
 * `--steps-border`, `--steps-text`, `--steps-muted` and `--steps-accent`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { signalTools } from "../../handlers/signals.ts";

/** A step, as the progress list and buttons know it. */
type StepEntry = { id: string; title: string };

/**
 * Per instance: the steps in page order, and the id of the one showing.
 * The rest follows from those two.
 */
const stepsSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed, perInstance }) =>
    perInstance(() => {
      const steps = new Signal<StepEntry[]>([]);
      const current = new Signal("");
      const at = () =>
        steps.value.findIndex((step) => step.id === current.value);
      // Until the steps connect, the last step's controls show: the form's
      // own submit, without Back or Next.
      const last = () =>
        steps.value.length === 0 || at() === steps.value.length - 1;
      return {
        steps,
        current,
        index: new Computed(at, [steps, current]),
        onFirst: new Computed(() => at() <= 0, [steps, current]),
        onLast: new Computed(last, [steps, current]),
        notLast: new Computed(() => !last(), [steps, current]),
        /** "Step 2 of 4", once the steps connect. */
        summary: new Computed(
          () =>
            steps.value.length
              ? `Step ${at() + 1} of ${steps.value.length}`
              : "",
          [steps, current],
        ),
      };
    }),
);

/** Helpers the handlers share, called through `fn`. */
const stepsTools = new tiny.Handlers(import.meta.url, {
  /** The step's first field that is not valid, if any. */
  firstInvalid(step: Element): HTMLInputElement | undefined {
    return [
      ...step.querySelectorAll<HTMLInputElement>("input, select, textarea"),
    ].find((field) => field.willValidate && !field.checkValidity());
  },
  /** Focuses the step's first field, or else the step itself. */
  focusStep(id: string): void {
    const step = document.getElementById(id);
    const field = step?.querySelector<HTMLElement>(
      "input:not([type=hidden]), select, textarea, button",
    );
    (field ?? step)?.focus();
  },
});

const stepsHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(stepsSignals, stepsTools);
  return {
    /**
     * Lists the step in page order, showing it if it was rendered
     * `current` or is the first to connect.
     */
    joinSteps: function (this: HTMLFieldSetElement) {
      this.id ||= `tiny-step-${crypto.randomUUID().slice(0, 8)}`;
      const steps = signal.steps.forInstance(this);
      const current = signal.current.forInstance(this);
      const entry = { id: this.id, title: this.dataset.title ?? "" };
      steps.value = [
        ...steps.value.filter((step) => step.id !== this.id),
        entry,
      ].sort((a, b) => {
        const before = document.getElementById(a.id);
        const after = document.getElementById(b.id);
        if (!before || !after) return 0;
        return before.compareDocumentPosition(after) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1;
      });
      if (!current.value || this.hasAttribute("data-current")) {
        current.value = this.id;
      }
    },
    /** Drops a step leaving the page, showing the first if it was showing. */
    leaveSteps: function (this: HTMLFieldSetElement) {
      const steps = signal.steps.forInstance(this);
      const current = signal.current.forInstance(this);
      steps.value = steps.value.filter((step) => step.id !== this.id);
      if (current.value === this.id) current.value = steps.value[0]?.id ?? "";
    },
    showStep: function (this: HTMLFieldSetElement) {
      this.toggleAttribute(
        "data-current",
        signal.current.forInstance(this).value === this.id,
      );
    },
    /** Moves on from the step once its fields are valid. */
    nextStep: function (this: HTMLElement) {
      const steps = signal.steps.forInstance(this).value;
      const current = signal.current.forInstance(this);
      const next = steps[signal.index.forInstance(this).value + 1];
      const step = document.getElementById(current.value);
      if (!next || !step) return;
      const invalid = fn.firstInvalid(step);
      if (invalid) return void invalid.reportValidity();
      current.value = next.id;
      fn.focusStep(next.id);
    },
    previousStep: function (this: HTMLElement) {
      const steps = signal.steps.forInstance(this).value;
      const back = steps[signal.index.forInstance(this).value - 1];
      if (!back) return;
      signal.current.forInstance(this).value = back.id;
      fn.focusStep(back.id);
    },
    /**
     * Moves on with Enter in a field, as Next does, rather than submitting
     * the form from a step before the last.
     */
    enterInStep: function (this: HTMLFieldSetElement, event: KeyboardEvent) {
      const field = event.target as HTMLElement;
      if (
        event.key !== "Enter" || event.defaultPrevented || event.isComposing ||
        !field.matches("input:not([type=submit], [type=button])") ||
        signal.onLast.forInstance(this).value
      ) return;
      event.preventDefault();
      const steps = signal.steps.forInstance(this).value;
      const next = steps[signal.index.forInstance(this).value + 1];
      const invalid = fn.firstInvalid(this);
      if (invalid) return void invalid.reportValidity();
      if (!next) return;
      signal.current.forInstance(this).value = next.id;
      fn.focusStep(next.id);
    },
    /**
     * Stops the form sending while a step has a field to fix, showing that
     * step and reporting the field.
     */
    checkSteps: function (this: HTMLButtonElement, event: MouseEvent) {
      for (const { id } of signal.steps.forInstance(this).value) {
        const step = document.getElementById(id);
        const invalid = step && fn.firstInvalid(step);
        if (!invalid) continue;
        event.preventDefault();
        signal.current.forInstance(this).value = id;
        invalid.reportValidity();
        return;
      }
    },
    /** Lists the steps, marking the finished ones, the current and the rest. */
    showProgress: function (this: HTMLOListElement) {
      const steps = signal.steps.forInstance(this).value;
      const at = signal.index.forInstance(this).value;
      this.replaceChildren(...steps.map((step, index) => {
        const item = document.createElement("li");
        item.dataset.state = index < at
          ? "done"
          : index === at
          ? "current"
          : "upcoming";
        if (index === at) item.setAttribute("aria-current", "step");
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.step = step.id;
        button.disabled = index >= at;
        const number = document.createElement("span");
        number.textContent = String(index + 1);
        button.append(number, step.title);
        item.append(button);
        return item;
      }));
    },
    /** Goes back to a finished step chosen in the progress list. */
    jumpToStep: function (this: HTMLOListElement, event: MouseEvent) {
      const button = (event.target as Element).closest?.("[data-step]") as
        | HTMLButtonElement
        | null;
      if (!button || button.disabled) return;
      signal.current.forInstance(this).value = button.dataset.step!;
      fn.focusStep(button.dataset.step!);
    },
  };
});

const stepsStyles = new tiny.Styles(import.meta.url, {
  step: css`
    min-width: 0;
    margin: 0;
    padding: 0;
    border: none;

    > legend {
      margin-bottom: 0.75rem;
      padding: 0;
      font-size: 1.125rem;
      font-weight: 600;
    }
    @media (scripting: enabled) {
      &:not([data-current]) {
        display: none;
      }
    }
  `,
  progress: css`
    display: flex;
    gap: 0.5rem;
    margin: 0 0 1.25rem;
    padding: 0;
    list-style: none;
    counter-reset: none;

    > li {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 0.5rem;
      color: var(--steps-muted, #6b7280);
    }
    > li:not(:last-child)::after {
      content: "";
      flex: 1;
      height: 2px;
      background: var(--steps-border, #d1d5db);
    }
    > li[data-state="done"]::after {
      background: var(--steps-accent, #047857);
    }
    button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      white-space: nowrap;
    }
    button:not(:disabled) {
      cursor: pointer;
    }
    button:not(:disabled):hover {
      text-decoration: underline;
    }
    span {
      display: grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      border: 2px solid var(--steps-border, #d1d5db);
      border-radius: 50%;
      font-size: 0.8125rem;
      font-weight: 600;
    }
    [data-state="current"] {
      color: var(--steps-text, #111827);
      font-weight: 600;
    }
    [data-state="current"] span {
      border-color: var(--steps-accent, #047857);
      color: var(--steps-accent, #047857);
    }
    [data-state="done"] {
      color: var(--steps-text, #111827);
    }
    [data-state="done"] span {
      border-color: var(--steps-accent, #047857);
      background: var(--steps-accent, #047857);
      color: #fff;
    }
    @media (scripting: none) {
      display: none;
    }
  `,
  // Back and Next need the page's script, so they stay hidden without it.
  scripted: css`
    &[hidden] {
      display: none;
    }
    @media (scripting: none) {
      display: none;
    }
  `,
  submit: css`
    &[hidden] {
      display: none;
    }
  `,
});

/**
 * `Step`s hold the form's fields, one showing at a time. `Progress` lists
 * them, `Status` says which is showing, and `Back`, `Next` and `Submit`
 * move through them and send the form. All expose `signal.current`, the
 * showing step's id, and `signal.index`, its place.
 */
export const StepsSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      stepsSignals,
      stepsHandlers,
      stepsStyles,
      signalTools,
    );
    // Controls placed after the steps connect once the steps have changed
    // these signals, so each catches up with `fireSelfSignal`.
    const exposed = [signal.current, signal.index];
    return {
      Step: instanced((props: {
        /** Its heading, also its name in the progress list. */
        title: string;
        /** Shows it first, rather than the first step. */
        current?: boolean;
        /** Its id, for the page's own use. */
        id?: string;
        children?: unknown;
      }) => (
        <fieldset
          id={props.id}
          class={styled.step}
          tabindex="-1"
          data-title={props.title}
          data-current={props.current ? "" : undefined}
          onConnect={[signal.steps, signal.current, fn.joinSteps]}
          onSignal={fn.showStep}
          onDisconnect={fn.leaveSteps}
          onKeyDown={fn.enterInStep}
        >
          <legend>{props.title}</legend>
          {props.children}
        </fieldset>
      ), exposed),
      Progress: instanced((props: { label?: string }) => (
        <ol
          class={styled.progress}
          aria-label={props.label ?? "Progress"}
          onConnect={[signal.steps, signal.current, fn.showProgress]}
          onSignal={fn.showProgress}
          onClick={fn.jumpToStep}
        />
      ), exposed),
      Status: instanced(
        () => (
          <output
            onConnect={[signal.summary, fn.fireSelfSignal]}
            onSignal={fn.setTextContent}
          />
        ),
        exposed,
      ),
      Back: instanced((props: { children?: unknown }) => (
        <button
          type="button"
          class={styled.scripted}
          disabled={signal.onFirst}
          onConnect={[signal.onFirst, fn.fireSelfSignal]}
          onClick={fn.previousStep}
        >
          {props.children ?? "Back"}
        </button>
      ), exposed),
      Next: instanced((props: { children?: unknown }) => (
        <button
          type="button"
          class={styled.scripted}
          hidden={signal.onLast}
          onConnect={[signal.onLast, fn.fireSelfSignal]}
          onClick={fn.nextStep}
        >
          {props.children ?? "Next"}
        </button>
      ), exposed),
      Submit: instanced((props: {
        name?: string;
        value?: string;
        /** The form it sends, if it sits outside it. */
        form?: string;
        formaction?: string;
        children?: unknown;
      }) => (
        <button
          type="submit"
          class={styled.submit}
          name={props.name}
          value={props.value}
          form={props.form}
          formaction={props.formaction}
          hidden={signal.notLast}
          onConnect={[signal.notLast, fn.fireSelfSignal]}
          onClick={fn.checkSteps}
        >
          {props.children ?? "Submit"}
        </button>
      ), exposed),
    };
  },
);
