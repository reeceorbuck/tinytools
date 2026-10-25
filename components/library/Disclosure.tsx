/**
 * A `<details>` section whose open state other parts can follow and set, and
 * which can remember it per viewer.
 *
 * ```tsx
 * const { component } = await tiny.imports(DisclosureSignalComponent);
 * const filters = component.instance();
 *
 * <filters.Toggle>Filters</filters.Toggle>
 * <filters.Details summary="Filters" remember="chart-filters">…</filters.Details>
 * ```
 *
 * `Details` sharing a `name` form an accordion: opening one closes the rest,
 * as the browser does for `<details name>`, and each one's `signal.open`
 * follows.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import type { SignalEvent } from "../../handlers/signals.ts";

/** Whether the section is open, one per instance. */
const disclosureSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, perInstance }) =>
    perInstance(() => ({ open: new Signal<boolean>(false) })),
);

const disclosureHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { signal } = await tiny.imports(disclosureSignals);
  // A `remember` key keeps its state in localStorage, as `tiny-details:<key>`.
  return {
    /** Restores a remembered state, then takes the section's own. */
    adoptDetails: function (this: HTMLDetailsElement) {
      // Chrome drops the `ontoggle` of an open `<details>` parsed inside a
      // `<template>` (a streamed partial): its first toggle fires there,
      // where the handler can't compile. Setting it again compiles it.
      const onToggle = this.getAttribute("ontoggle");
      if (onToggle && this.ontoggle === null) {
        this.setAttribute("ontoggle", onToggle);
      }
      const key = this.dataset.remember;
      if (key) {
        try {
          const stored = localStorage.getItem(`tiny-details:${key}`);
          if (stored !== null) this.open = stored === "open";
        } catch { /* Storage blocked: keep the rendered state. */ }
      }
      signal.open.forInstance(this).value = this.open;
    },
    /** Notes a toggle however it came about, remembering it if asked. */
    detailsToggled: function (this: HTMLDetailsElement) {
      signal.open.forInstance(this).value = this.open;
      const key = this.dataset.remember;
      if (!key) return;
      try {
        localStorage.setItem(
          `tiny-details:${key}`,
          this.open ? "open" : "closed",
        );
      } catch { /* Storage blocked: the state is not remembered. */ }
    },
    /** Opens or closes the section as `open` changes. */
    showDetails: function (this: HTMLDetailsElement, event: SignalEvent) {
      const open = Boolean(event.signal.value);
      if (this.open !== open) this.open = open;
    },
    toggleDetails: function (this: HTMLButtonElement) {
      const open = signal.open.forInstance(this);
      open.value = !open.value;
    },
    /** Keeps the button's `aria-expanded` in step. */
    showExpanded: function (this: HTMLButtonElement) {
      this.setAttribute(
        "aria-expanded",
        String(signal.open.forInstance(this).value),
      );
    },
  };
});

const disclosureStyles = new tiny.Styles(import.meta.url, {
  // The toggle needs the page's script, so it stays hidden without it.
  toggle: css`
    @media (scripting: none) {
      display: none;
    }
  `,
});

/**
 * `Details` is the section, its `summary` the always-visible line that opens
 * it. `Toggle` is a button opening and closing it from elsewhere. Both
 * expose `signal.open`, which opens the section when set true.
 */
export const DisclosureSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      disclosureSignals,
      disclosureHandlers,
      disclosureStyles,
    );
    return {
      Details: instanced((props: {
        /** What the `<summary>` shows. */
        summary: unknown;
        open?: boolean;
        /** Sections sharing a name open one at a time. */
        name?: string;
        /**
         * Remembers the open state in this viewer's browser under this key,
         * restoring it as the page loads.
         */
        remember?: string;
        children?: unknown;
      }) => (
        <details
          open={props.open}
          name={props.name}
          data-remember={props.remember}
          onConnect={[signal.open, fn.adoptDetails]}
          onSignal={fn.showDetails}
          onToggle={fn.detailsToggled}
        >
          <summary>{props.summary}</summary>
          {props.children}
        </details>
      ), [signal.open]),
      Toggle: instanced(
        (props: { children?: unknown; label?: string }) => (
          <button
            type="button"
            class={styled.toggle}
            aria-expanded="false"
            aria-label={props.label}
            onConnect={[signal.open, fn.showExpanded]}
            onSignal={fn.showExpanded}
            onClick={fn.toggleDetails}
          >
            {props.children ?? "Toggle"}
          </button>
        ),
        [signal.open],
      ),
    };
  },
);
