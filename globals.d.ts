/**
 * Ambient type declarations for browser APIs not yet in TypeScript's DOM lib.
 * Reference this file in your project to get types for:
 * - Navigation API (navigation.navigate(), NavigateEvent, etc.)
 * - CommandEvent (Invoker Commands API)
 *
 * Usage in Deno:
 *   /// <reference types="tinytools/globals" />
 *
 * @module
 */

// ============================================================================
// Navigation API
// https://html.spec.whatwg.org/multipage/nav-history-apis.html
// ============================================================================

interface NavigationHistoryEntry extends EventTarget {
  readonly url: string | null;
  readonly key: string;
  readonly id: string;
  readonly index: number;
  readonly sameDocument: boolean;
  getState(): unknown;
}

interface NavigateEvent extends Event {
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
  intercept(options?: { handler?: () => Promise<void> }): void;
  scroll(): void;
}

interface NavigationDestination {
  readonly url: string;
  readonly key: string | null;
  readonly id: string | null;
  readonly index: number;
  readonly sameDocument: boolean;
  getState(): unknown;
}

interface NavigationCurrentEntryChangeEvent extends Event {
  readonly navigationType?: "reload" | "push" | "replace" | "traverse";
  readonly from: NavigationHistoryEntry;
}

interface Navigation extends EventTarget {
  entries(): NavigationHistoryEntry[];
  readonly currentEntry?: NavigationHistoryEntry;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
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

interface Window {
  navigation: Navigation;
}

declare var navigation: Navigation;

// ============================================================================
// Invoker Commands API
// https://open-ui.org/components/invokers.explainer/
// ============================================================================

interface CommandEvent extends Event {
  source: HTMLButtonElement;
  command: string;
}
