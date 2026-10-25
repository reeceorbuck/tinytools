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
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";

/**
 * One count per instance. Each of its components is one part of a counter:
 * the parts made together by `component.instance()` share one count,
 * wherever they sit on the page.
 */
const counterSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) => perInstance(() => ({ count: new Signal(0) })),
);

const counterHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(counterSignals);
  return {
    /** Changes the count by the button's `data-by`. */
    changeCount: function (this: HTMLButtonElement) {
      signal.count.forInstance(this).value += Number(this.dataset.by);
    },
  };
});

const counterStyles = new tiny.Styles(import.meta.url, {
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
 * `CounterDisplay` shows the count and `Increment` changes it by `by`. Both
 * expose `signal.count`: a click bound to it outside the component adds 1.
 */
export const CounterSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      counterSignals,
      counterHandlers,
      counterStyles,
    );
    return {
      CounterDisplay: instanced(
        <output class={styled.counterDisplay} aria-live="polite">
          {signal.count}
        </output>,
        [signal.count],
      ),
      Increment: instanced((props: { by: number }) => (
        <button
          type="button"
          class={styled.counterButton}
          aria-label={`Change count by ${props.by}`}
          data-by={props.by}
          onClick={fn.changeCount}
        >
          {props.by < 0 ? `−${-props.by}` : `+${props.by}`}
        </button>
      ), [signal.count]),
    };
  },
);
