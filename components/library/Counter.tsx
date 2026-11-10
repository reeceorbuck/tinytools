/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A counter: a display and any number of buttons that change its count.
 *
 * ```tsx
 * const { component } = await tiny.imports(CounterSignalComponent);
 * const counter = component.instance();
 *
 * <counter.Increment by={-1} />
 * <counter.CounterDisplay />
 * <counter.Increment by={1} />
 * ```
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h, type JSX } from "../../jsx-runtime.ts";
import {
  type ExposedSignals,
  type InstanceSignals,
  optimized,
  type Signal,
  type SignalComponent,
} from "../../mod.ts";
import { css } from "../../scopedStyles.ts";

const tiny = optimized(import.meta.url);

/**
 * One count per instance. Each of its components is one part of a counter:
 * the parts made together by `component.instance()` share one count,
 * wherever they sit on the page.
 */
const counterSignals = new tiny.Signals(({ Signal, Scope }) =>
  new Scope(() => ({ count: new Signal(0) }))
);

/** The signals a counter exposes. */
type CounterExposed = InstanceSignals<{ count: Signal<number> }>;

const counterHandlers = new tiny.Handlers(async () => {
  const { signal } = await tiny.imports(counterSignals);
  return {
    /** Changes the count by the button's `data-by`. */
    changeCount: function (this: HTMLButtonElement) {
      signal.count.forInstance(this).value += Number(this.dataset.by);
    },
  };
});

const counterStyles = new tiny.Styles({
  counterDisplay: css`
    display: inline-block;
    min-width: 3ch;
    font: 600 1.5rem/1 ui-monospace, monospace;
    text-align: center;
  `,
  counterButton: css`
    min-width: 2.5rem;
    font-size: 1.25rem;
  `,
});

/**
 * `CounterDisplay` shows the count and `Increment` changes it by `by`. The
 * counter exposes `signal.count`: `onClick={counter.signal.count.increment}`
 * outside the component adds 1.
 */
export const CounterSignalComponent: SignalComponent<{
  signal: ExposedSignals<CounterExposed>;
  CounterDisplay: JSX.Element;
  Increment: (props: { by: number }) => JSX.Element;
}> = new tiny.SignalComponent(
  async () => {
    const { fn, signal, styled } = await tiny.imports(
      counterSignals,
      counterHandlers,
      counterStyles,
    );
    return {
      signal: [signal.count],
      CounterDisplay: (
        <output class={styled.counterDisplay} aria-live="polite">
          {signal.count}
        </output>
      ),
      Increment: (props: { by: number }) => (
        <button
          type="button"
          class={styled.counterButton}
          aria-label={`Change count by ${props.by}`}
          data-by={props.by}
          onClick={fn.changeCount}
        >
          {props.by < 0 ? `−${-props.by}` : `+${props.by}`}
        </button>
      ),
    };
  },
);
