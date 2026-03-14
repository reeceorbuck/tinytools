/**
 * Client-side module for @tiny-tools/hono
 *
 * Provides client-side scripts for partial navigation, event handling,
 * and DOM updates. These scripts should be served from your public directory.
 *
 * To use this module, copy the client files to your public directory
 * or import and serve them directly.
 *
 * @module
 */

// Re-export client utilities for reference
// Note: These are meant to be built and served as static JS files
// Use the build module to transpile them

export const CLIENT_FILES = [
  "eventHandlers.ts",
  "navigation.ts",
  "performFetchAndUpdate.ts",
  "processIncomingData.ts",
  "processIncomingHtml.ts",
  "localRoutes.ts",
  "mutationObserver.ts",
  "sse.ts",
  "wc-lifecycleElement.ts",
  "wc-windowEventlistener.ts",
] as const;

export type ClientFile = typeof CLIENT_FILES[number];
