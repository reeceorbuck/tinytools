/**
 * A search box filtering what the page lists, as it is typed, with a count of
 * the matches and a message for none. Each part sits wherever the page puts
 * it.
 *
 * ```tsx
 * const { component } = await tiny.imports(SearchFilterSignalComponent);
 * const stockFilter = component.instance();
 *
 * <stockFilter.FilterInput label="Filter items" />
 * <stockFilter.MatchCount />
 * <stockFilter.Results>
 *   <section data-filter-group>
 *     <h2>Gloves</h2>
 *     <StockRow data-filter="nitrile gloves small" />
 *   </section>
 * </stockFilter.Results>
 * <stockFilter.NoMatches>Nothing matches.</stockFilter.NoMatches>
 * ```
 *
 * `Results` hides each element inside it marked `data-filter` that does not
 * hold every word typed, matching the attribute's value or, when it is
 * empty, the element's text; case and accents are ignored. An element marked
 * `data-filter-group` is hidden while none of its `data-filter` elements
 * shows. Hidden elements carry `hidden`, which wins over their own `display`.
 *
 * Results filter as `Results` connects and as the query changes, so a
 * partial replacing `Results` is filtered as it arrives; rows added inside
 * it some other way show until the next keystroke.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { type HandlerReference, tiny } from "../../mod.ts";
import { css, setCustomScope } from "../../scopedStyles.ts";

/**
 * One query per instance. The input writes `query`, and `Results` writes
 * how many of its elements there are and how many match it.
 */
const searchFilterSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed, perInstance }) =>
    perInstance(() => {
      const query = new Signal("");
      const shown = new Signal(0);
      const total = new Signal(0);
      return {
        query,
        shown,
        total,
        /** "3 of 40" while a query filters the results; empty otherwise. */
        summary: new Computed(
          () => query.value.trim() ? `${shown.value} of ${total.value}` : "",
          [query, shown, total],
        ),
        /** Whether a query matches nothing. */
        noMatches: new Computed(
          () => query.value.trim() !== "" && shown.value === 0,
          [query, shown],
        ),
      };
    }),
);

const searchFilterHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(searchFilterSignals);
  return {
    /** Takes the input's value, which a back navigation may have restored. */
    adoptQuery: function (this: HTMLInputElement) {
      signal.query.forInstance(this).value = this.value;
    },
    /** Hides the elements the query does not match, and counts them. */
    applyFilter: function (this: HTMLElement) {
      // Lower case, without accents, so "Cafe" matches "café".
      const fold = (text: string) =>
        text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
      const words = fold(signal.query.forInstance(this).value)
        .split(/\s+/).filter(Boolean);
      const items = this.querySelectorAll<HTMLElement>("[data-filter]");
      let shown = 0;
      for (const item of items) {
        const text = fold(item.dataset.filter || item.textContent || "");
        item.hidden = !words.every((word) => text.includes(word));
        if (!item.hidden) shown++;
      }
      for (
        const group of this.querySelectorAll<HTMLElement>("[data-filter-group]")
      ) {
        group.hidden = !group.querySelector("[data-filter]:not([hidden])");
      }
      signal.shown.forInstance(this).value = shown;
      signal.total.forInstance(this).value = items.length;
    },
    /** Shows the element only while the query matches nothing. */
    showNoMatches: function (this: HTMLElement) {
      this.hidden = !signal.noMatches.forInstance(this).value;
    },
  };
});

const searchFilterStyles = new tiny.Styles(import.meta.url, {
  // Unscoped, so it reaches rows that are other components' roots too.
  results: setCustomScope.unscoped(css`
    [data-filter][hidden],
    [data-filter-group][hidden] {
      display: none !important;
    }
  `),
  filterInput: css`
    min-width: 0;
  `,
});

/** A handler, or several, run on the input's own events. */
type InputHandler =
  | HandlerReference<string, (event: Event) => unknown>
  | readonly HandlerReference<string, (event: Event) => unknown>[];

/**
 * `FilterInput` is the search box, `Results` holds what it filters,
 * `MatchCount` shows "3 of 40" while it filters and `NoMatches` shows its
 * children while nothing matches. `FilterInput` exposes `signal.query`;
 * `Results` and `MatchCount` expose `signal.shown`, `signal.total` and
 * `signal.summary`.
 */
export const SearchFilterSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      searchFilterSignals,
      searchFilterHandlers,
      searchFilterStyles,
    );
    return {
      FilterInput: instanced((props: {
        /** Its form field name, for a server that filters too. */
        name?: string;
        /** Its accessible name; by default "Filter". */
        label?: string;
        placeholder?: string;
        /** The query to start with, such as the request's own. */
        value?: string;
        id?: string;
        /** Runs on every keystroke, after the filter (to submit, say). */
        onInput?: InputHandler;
      }) => (
        <input
          type="search"
          class={styled.filterInput}
          name={props.name ?? "search"}
          id={props.id}
          aria-label={props.label ?? "Filter"}
          placeholder={props.placeholder ?? props.label ?? "Filter"}
          value={props.value ?? ""}
          autocomplete="off"
          onConnect={[signal.query, fn.adoptQuery]}
          onInput={[signal.query, ...[props.onInput ?? []].flat()]}
        />
      ), [signal.query]),
      Results: instanced((props: {
        /** Its element; a `tbody` filters a table's rows. Default `div`. */
        as?: "div" | "ul" | "ol" | "tbody" | "section";
        children?: unknown;
      }) => {
        const Tag = props.as ?? "div";
        return (
          <Tag
            class={styled.results}
            onConnect={[signal.query, fn.applyFilter]}
            onSignal={fn.applyFilter}
          >
            {props.children}
          </Tag>
        );
      }, [signal.shown, signal.total, signal.summary]),
      MatchCount: instanced(
        <output aria-live="polite">{signal.summary}</output>,
        [signal.shown, signal.total, signal.summary],
      ),
      NoMatches: instanced((props: { children?: unknown }) => (
        <p
          hidden
          onConnect={[signal.noMatches, fn.showNoMatches]}
          onSignal={fn.showNoMatches}
        >
          {props.children ?? "No matches."}
        </p>
      )),
    };
  },
);
