/**
 * Typed accessor for the browser Navigation API global.
 *
 * Defined here so client modules can share a single typed reference
 * without modifying global types (which JSR forbids in published packages).
 *
 * @module
 */

import type { Navigation } from "../globals.d.ts";

/** Typed reference to `globalThis.navigation` (Navigation API). */
export const navigation: Navigation =
  (globalThis as unknown as { navigation: Navigation }).navigation;
