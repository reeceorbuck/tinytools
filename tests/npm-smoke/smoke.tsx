// Renders each page through app.fetch and fetches every asset it links. Run
// by scripts/npm_smoke.ts under Node and Bun, against the packed npm build.
import { app } from "./app.tsx";

const failures: string[] = [];
const seen = new Set<string>();
for (const path of ["/", "/counter", "/profile"]) {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  const html = await res.text();
  if (res.status !== 200) {
    failures.push(`${path} -> ${res.status}: ${html.slice(0, 300)}`);
    continue;
  }
  for (
    const [, asset] of html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)
  ) {
    if (seen.has(asset)) continue;
    seen.add(asset);
    const assetRes = await app.fetch(new Request(`http://localhost${asset}`));
    const body = await assetRes.text();
    if (assetRes.status !== 200 || !body) {
      failures.push(`${asset} -> ${assetRes.status}`);
    }
  }
}
if (!seen.size) failures.push("no assets linked");
console.log(
  failures.length ? `FAIL\n${failures.join("\n")}` : `OK (${seen.size} assets)`,
);
if (failures.length) process.exitCode = 1;
