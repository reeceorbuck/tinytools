import type { Handlers } from "../mod.ts";
import { sourcedCollections } from "../clientTools.ts";

const sourced = sourcedCollections(import.meta.url);

/**
 * The id of this tab, which the server combines with the browser's `sseId`
 * cookie so each tab has its own stream and path history. It lives on the
 * page, not in `sessionStorage`, which a duplicated tab would copy.
 */
export const tabIdTools: Handlers<{
  /** This page's tab id, made on first use: 32 hex characters. */
  tabId(): string;
}> = new sourced.Handlers({
  tabId: function (): string {
    const page = globalThis as typeof globalThis & { ttTabId?: string };
    // getRandomValues, unlike randomUUID, works outside secure contexts.
    return page.ttTabId ??= Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  },
});
