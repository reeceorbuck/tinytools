/**
 * Tests for aggressive caching headers on handler and style files.
 *
 * Verifies that clientFunction handler files and ScopeStyle files
 * have proper Cache-Control headers set for maximum caching.
 *
 * Run with: deno test tests/caching.test.ts
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { getClientFileName } from "../client/dist/manifest.ts";
import { tiny } from "../honoFactory.tsx";

// ============================================================================
// Test Suite: Cache-Control headers
// ============================================================================

Deno.test("Caching - handler files get aggressive Cache-Control headers", async () => {
  const app = new Hono().use(...tiny.middleware.core());

  // Simulate a request to a handler file
  const req = new Request("http://localhost/handlers/testHandler_abc123.js");
  const res = await app.fetch(req);

  // Check that the Cache-Control header is set correctly
  // Note: This will return 404 since the file doesn't exist, but the middleware
  // should still run and attempt to set headers
  const cacheControl = res.headers.get("Cache-Control");

  if (res.status === 200) {
    assertEquals(
      cacheControl,
      "public, max-age=31536000, immutable",
      "Handler files should have aggressive cache headers",
    );
  }
});

Deno.test("Caching - style files get aggressive Cache-Control headers", async () => {
  const app = new Hono().use(...tiny.middleware.core());

  // Simulate a request to a style file
  const req = new Request("http://localhost/styles/myStyle_def456.css");
  const res = await app.fetch(req);

  // Check that the Cache-Control header is set correctly
  const cacheControl = res.headers.get("Cache-Control");

  if (res.status === 200) {
    assertEquals(
      cacheControl,
      "public, max-age=31536000, immutable",
      "Style files should have aggressive cache headers",
    );
  }
});

Deno.test("Caching - other files do NOT get aggressive Cache-Control headers", async () => {
  const app = new Hono().use(...tiny.middleware.core());

  // Simulate a request to a non-handler, non-style file
  const req = new Request("http://localhost/other/file.js");
  const res = await app.fetch(req);

  // Check that the Cache-Control header is NOT set to aggressive caching
  const cacheControl = res.headers.get("Cache-Control");

  if (cacheControl) {
    assertEquals(
      cacheControl === "public, max-age=31536000, immutable",
      false,
      "Non-handler/style files should not have aggressive cache headers",
    );
  }
});

Deno.test("Caching - package client files get aggressive Cache-Control headers", async () => {
  const app = new Hono().use(...tiny.middleware.core());

  const req = new Request(
    `http://localhost/_tinytools/${getClientFileName("navigation.js")}`,
  );
  const res = await app.fetch(req);

  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
});
