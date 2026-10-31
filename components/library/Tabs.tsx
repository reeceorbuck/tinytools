/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Tabs: a row of tabs choosing which of their panels shows. The tab list and
 * each panel sit wherever the page puts them, so the tabs can live in a
 * header and the panels in the body.
 *
 * ```tsx
 * const { component } = await tiny.imports(TabsSignalComponent);
 * const chart = component.instance();
 *
 * <chart.List label="Chart views" value="notes" remember="chart-view">
 *   <chart.Tab value="notes">Notes</chart.Tab>
 *   <chart.Tab value="xrays">X-rays</chart.Tab>
 * </chart.List>
 * <chart.Panel value="notes" selected>…</chart.Panel>
 * <chart.Panel value="xrays">…</chart.Panel>
 * ```
 *
 * The list's `value` is the tab selected as the page loads (by default its
 * first); mark that tab's panel `selected` too, so it shows before the
 * script runs. Arrow keys, Home and End move between tabs, selecting as they
 * go. Several panels may share a value, and a panel with none of the tabs'
 * values never shows.
 *
 * Colours come from custom properties a caller may set on the list or any
 * ancestor: `--tabs-border`, `--tabs-text`, `--tabs-muted` and
 * `--tabs-accent`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { createContext, useContext } from "hono/jsx";
import {
  type InstancedComponent,
  type InstanceSignals,
  type Signal,
  type SignalComponent,
  tiny,
} from "../../mod.ts";
import { css } from "../../scopedStyles.ts";

/** The selected tab's value, one per instance. */
const tabsSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({ selected: new Signal("") })),
);

/** The signals the tabs' parts expose. */
type TabsExposed = InstanceSignals<{ selected: Signal<string> }>;

/** The tab list's props. */
type ListProps = {
  /** Names the tabs to assistive technology. */
  label?: string;
  /** The tab selected as the page loads; by default the first. */
  value?: string;
  /**
   * Remembers the chosen tab in this viewer's browser under this key,
   * restoring it as the page loads.
   */
  remember?: string;
  /** Lays the tabs out in a column, moved through with ↑ and ↓. */
  vertical?: boolean;
  children?: unknown;
};

/** A tab's props. */
type TabProps = {
  value: string;
  disabled?: boolean;
  children?: unknown;
};

/** A panel's props. */
type PanelProps = {
  value: string;
  /** Shows it before the script runs: the list's starting value's panel. */
  selected?: boolean;
  /** Names the panel to assistive technology. */
  label?: string;
  children?: unknown;
};

const tabsHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(tabsSignals);
  // A `remember` key keeps the choice in localStorage, as `tiny-tabs:<key>`.
  return {
    /**
     * Selects the remembered tab, or else the list's `data-value`, or else
     * its first tab. A tab remembered that is no longer listed is ignored.
     */
    adoptTabs: function (this: HTMLElement) {
      const tabs = [...this.querySelectorAll<HTMLElement>('[role="tab"]')];
      const values = tabs.map((tab) => tab.dataset.value ?? "");
      let value = this.dataset.value ?? "";
      const key = this.dataset.remember;
      if (key) {
        try {
          const stored = localStorage.getItem(`tiny-tabs:${key}`);
          if (stored !== null && values.includes(stored)) value = stored;
        } catch { /* Storage blocked: keep the rendered choice. */ }
      }
      if (!values.includes(value)) value = values[0] ?? "";
      signal.selected.forInstance(this).value = value;
    },
    /** Remembers the choice, when the list asks to. */
    rememberTab: function (this: HTMLElement) {
      const key = this.dataset.remember;
      if (!key) return;
      try {
        localStorage.setItem(
          `tiny-tabs:${key}`,
          signal.selected.forInstance(this).value,
        );
      } catch { /* Storage blocked: the choice is not remembered. */ }
    },
    selectTab: function (this: HTMLButtonElement) {
      signal.selected.forInstance(this).value = this.dataset.value ?? "";
    },
    /** Moves to the next or previous tab, or the first or last, and selects it. */
    moveTab: function (this: HTMLElement, event: KeyboardEvent) {
      const tabs = [...this.querySelectorAll<HTMLElement>('[role="tab"]')]
        .filter((tab) => !tab.hasAttribute("disabled"));
      const current = tabs.indexOf(event.target as HTMLElement);
      if (current < 0) return;
      const vertical = this.getAttribute("aria-orientation") === "vertical";
      const keys: Record<string, number> = {
        [vertical ? "ArrowDown" : "ArrowRight"]: current + 1,
        [vertical ? "ArrowUp" : "ArrowLeft"]: current - 1,
        Home: 0,
        End: tabs.length - 1,
      };
      if (!(event.key in keys)) return;
      event.preventDefault();
      const next = tabs.at(keys[event.key] % tabs.length)!;
      next.focus();
      signal.selected.forInstance(this).value = next.dataset.value ?? "";
    },
    /** Marks the tab selected, and only it reachable by Tab, while chosen. */
    showTab: function (this: HTMLButtonElement) {
      const selected =
        signal.selected.forInstance(this).value === this.dataset.value;
      this.setAttribute("aria-selected", String(selected));
      this.tabIndex = selected ? 0 : -1;
    },
    /** Shows the panel only while its tab is chosen. */
    showPanel: function (this: HTMLElement) {
      this.hidden =
        signal.selected.forInstance(this).value !== this.dataset.value;
    },
  };
});

const tabsStyles = new tiny.Styles(import.meta.url, {
  list: css`
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--tabs-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));

    &[aria-orientation="vertical"] {
      flex-direction: column;
      border-bottom: none;
      border-right: 1px solid var(--tabs-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    }
  `,
  tab: css`
    padding: 0.5rem 0.875rem;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    background: none;
    color: var(--tabs-muted, light-dark(oklch(44.6% 0.026 256.8), oklch(75.4% 0.026 256.8)));
    font: inherit;
    font-weight: 500;
    cursor: pointer;

    &:hover {
      color: var(--tabs-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    }
    &[aria-selected="true"] {
      border-bottom-color: var(--tabs-accent, oklch(50.8% 0.105 165.6));
      color: var(--tabs-text, light-dark(oklch(21% 0.032 264.7), oklch(97% 0.032 264.7)));
    }
    &:focus-visible {
      outline: 2px solid var(--tabs-accent, oklch(50.8% 0.105 165.6));
      outline-offset: -2px;
      border-radius: 4px;
    }
    [aria-orientation="vertical"] > & {
      border-bottom: none;
      border-right: 2px solid transparent;
      margin: 0 -1px 0 0;
      text-align: start;
    }
    [aria-orientation="vertical"] > &[aria-selected="true"] {
      border-right-color: var(--tabs-accent, oklch(50.8% 0.105 165.6));
    }
  `,
  panel: css`
    &:focus-visible {
      outline: 2px solid var(--tabs-accent, oklch(50.8% 0.105 165.6));
      outline-offset: 2px;
    }
  `,
});

/** The value a `List` starts on, for the tabs written inside it. */
const TabsContext = createContext({ value: undefined as string | undefined });
/** Typed for this package's JSX, which Hono's own component type is not. */
const TabsProvider = TabsContext.Provider as unknown as (
  props: { value: { value: string | undefined }; children?: unknown },
) => h.JSX.Element;

/**
 * `List` holds the `Tab`s written inside it; each `Tab` chooses the `Panel`s
 * of its `value`. All three expose `signal.selected`, the chosen value,
 * which selects that tab when set.
 */
export const TabsSignalComponent: SignalComponent<{
  List: InstancedComponent<TabsExposed, ListProps>;
  Tab: InstancedComponent<TabsExposed, TabProps>;
  Panel: InstancedComponent<TabsExposed, PanelProps>;
}> = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      tabsSignals,
      tabsHandlers,
      tabsStyles,
    );
    return {
      List: instanced((props: ListProps) => (
        <div
          role="tablist"
          class={styled.list}
          aria-label={props.label}
          aria-orientation={props.vertical ? "vertical" : undefined}
          data-value={props.value}
          data-remember={props.remember}
          onConnect={[signal.selected, fn.adoptTabs]}
          onSignal={fn.rememberTab}
          onKeyDown={fn.moveTab}
        >
          <TabsProvider value={{ value: props.value }}>
            {props.children}
          </TabsProvider>
        </div>
      ), [signal.selected]),
      Tab: instanced((props: TabProps) => {
        const { value } = useContext(TabsContext);
        // Without a list value, the first connect picks the first tab; until
        // then every tab stays reachable.
        const selected = value === props.value;
        return (
          <button
            type="button"
            role="tab"
            class={styled.tab}
            data-value={props.value}
            aria-selected={String(selected)}
            tabindex={selected || value === undefined ? 0 : -1}
            disabled={props.disabled}
            onConnect={[signal.selected, fn.showTab]}
            onSignal={fn.showTab}
            onClick={fn.selectTab}
          >
            {props.children ?? props.value}
          </button>
        );
      }, [signal.selected]),
      Panel: instanced((props: PanelProps) => (
        <section
          role="tabpanel"
          class={styled.panel}
          tabindex="0"
          aria-label={props.label}
          data-value={props.value}
          hidden={!props.selected}
          onConnect={[signal.selected, fn.showPanel]}
          onSignal={fn.showPanel}
        >
          {props.children}
        </section>
      ), [signal.selected]),
    };
  },
);
