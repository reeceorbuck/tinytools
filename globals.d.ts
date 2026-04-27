/**
 * Type declarations for browser APIs not yet in TypeScript's DOM lib.
 *
 * These are exported as a regular module (not ambient globals) so the package
 * can be published to JSR, which forbids modifying global types.
 *
 * Consumers can either:
 *   1. Import the types directly: `import type { NavigateEvent } from "@tinytools/hono-tools/globals";`
 *   2. Augment their own globals in a local `globals.d.ts`:
 *
 *        import type { Navigation, NavigateEvent } from "@tinytools/hono-tools/globals";
 *        declare global {
 *          interface Window { navigation: Navigation; }
 *          var navigation: Navigation;
 *          // re-export the event types as globals if desired
 *          type NavigateEventGlobal = NavigateEvent;
 *        }
 *
 * @module
 */

// ============================================================================
// Navigation API
// https://html.spec.whatwg.org/multipage/nav-history-apis.html
// ============================================================================

export interface NavigationHistoryEntry extends EventTarget {
  readonly url: string | null;
  readonly key: string;
  readonly id: string;
  readonly index: number;
  readonly sameDocument: boolean;
  // deno-lint-ignore no-explicit-any
  ondispose: ((this: NavigationHistoryEntry, ev: Event) => any) | null;
  getState(): unknown;
}

export interface NavigateEvent extends Event {
  readonly navigationType: "reload" | "push" | "replace" | "traverse";
  readonly destination: NavigationDestination;
  readonly canIntercept: boolean;
  readonly userInitiated: boolean;
  readonly hashChange: boolean;
  readonly signal: AbortSignal;
  readonly formData: FormData | null;
  readonly downloadRequest: string | null;
  readonly info: unknown;
  readonly hasUAVisualTransition: boolean;
  readonly sourceElement: Element | null;
  intercept(options?: NavigationInterceptOptions): void;
  scroll(): void;
}

export interface NavigationDestination {
  readonly url: string;
  readonly key: string | null;
  readonly id: string | null;
  readonly index: number;
  readonly sameDocument: boolean;
  getState(): unknown;
}

export interface NavigationCurrentEntryChangeEvent extends Event {
  readonly navigationType?: "reload" | "push" | "replace" | "traverse";
  readonly from: NavigationHistoryEntry;
}

export interface NavigationInterceptHandler {
  (event: NavigateEvent): Promise<void> | void;
}

export interface NavigationPrecommitController {
  redirect(url: string): void;
}

export interface NavigationInterceptOptions {
  focusReset?: "after-transition" | "manual";
  scroll?: "after-transition" | "manual";
  handler?: NavigationInterceptHandler;
  precommitHandler?: (
    controller: NavigationPrecommitController,
  ) => Promise<void> | void;
}

export interface NavigationEventMap {
  navigate: NavigateEvent;
  currententrychange: NavigationCurrentEntryChangeEvent;
}

export interface Navigation extends EventTarget {
  entries(): NavigationHistoryEntry[];
  readonly currentEntry?: NavigationHistoryEntry;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  addEventListener(
    type: "navigate",
    listener: (this: Navigation, ev: NavigateEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: "currententrychange",
    listener: (
      this: Navigation,
      ev: NavigationCurrentEntryChangeEvent,
    ) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "navigate",
    listener: (this: Navigation, ev: NavigateEvent) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: "currententrychange",
    listener: (
      this: Navigation,
      ev: NavigationCurrentEntryChangeEvent,
    ) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  navigate(
    url: string,
    options?: {
      state?: unknown;
      history?: "auto" | "push" | "replace";
      info?: unknown;
    },
  ): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  reload(
    options?: { state?: unknown; info?: unknown },
  ): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  traverseTo(
    key: string,
    options?: { info?: unknown },
  ): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  back(
    options?: { info?: unknown },
  ): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
  forward(
    options?: { info?: unknown },
  ): {
    committed: Promise<NavigationHistoryEntry>;
    finished: Promise<NavigationHistoryEntry>;
  };
}

// ============================================================================
// Invoker Commands API
// https://open-ui.org/components/invokers.explainer/
// ============================================================================

export interface CommandEvent extends Event {
  source: HTMLButtonElement;
  command: string;
}
