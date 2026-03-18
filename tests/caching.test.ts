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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getClientFileName } from "../client/dist/manifest.ts";
import { tiny } from "../honoFactory.tsx";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function withPublicFiles<T>(
  files: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previousCwd = Deno.cwd();
  const publicDir = `${packageDir}/public`;
  const hadPublicDir = await Deno.stat(publicDir).then(() => true).catch(() =>
    false
  );
  const createdFilePaths: string[] = [];

  Deno.chdir(packageDir);
  await Deno.mkdir(publicDir, { recursive: true });

  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = `${publicDir}/${relativePath.replaceAll("\\", "/")}`;
      const lastSlashIndex = filePath.lastIndexOf("/");
      const dirPath = filePath.slice(0, lastSlashIndex);

      await Deno.mkdir(dirPath, { recursive: true });
      await Deno.writeTextFile(filePath, content);
      createdFilePaths.push(filePath);
    }

    return await run();
  } finally {
    for (const filePath of createdFilePaths.reverse()) {
      await Deno.remove(filePath).catch(() => undefined);

      let currentDir = filePath.slice(0, filePath.lastIndexOf("/"));
      while (
        currentDir.startsWith(publicDir) &&
        currentDir.length >= publicDir.length
      ) {
        const removed = await Deno.remove(currentDir).then(() => true).catch(
          () => false
        );
        if (!removed || currentDir === publicDir) {
          break;
        }
        currentDir = currentDir.slice(0, currentDir.lastIndexOf("/"));
      }
    }

    if (!hadPublicDir) {
      await Deno.remove(publicDir).catch(() => undefined);
    }
    Deno.chdir(previousCwd);
  }
}

// ============================================================================
// Test Suite: Cache-Control headers
// ============================================================================

Deno.test("Caching - handler files get aggressive Cache-Control headers", async () => {
  await withPublicFiles({
    "handlers/testHandler_abc123.js": "console.log('handler');",
  }, async () => {
    const app = new Hono().use(...tiny.middleware.core());
    const req = new Request("http://localhost/handlers/testHandler_abc123.js");
    const res = await app.fetch(req);

    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
      "Handler files should have aggressive cache headers",
    );
  });
});

Deno.test("Caching - style files get aggressive Cache-Control headers", async () => {
  await withPublicFiles({
    "styles/myStyle_def456.css": "body { color: red; }",
  }, async () => {
    const app = new Hono().use(...tiny.middleware.core());
    const req = new Request("http://localhost/styles/myStyle_def456.css");
    const res = await app.fetch(req);

    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
      "Style files should have aggressive cache headers",
    );
  });
});

Deno.test("Caching - other files do NOT get aggressive Cache-Control headers", async () => {
  await withPublicFiles({
    "other/file.js": "console.log('other');",
  }, async () => {
    const app = new Hono().use(...tiny.middleware.core());
    const req = new Request("http://localhost/other/file.js");
    const res = await app.fetch(req);

    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("Cache-Control") ===
        "public, max-age=31536000, immutable",
      false,
      "Non-handler/style files should not have aggressive cache headers",
    );
  });
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
