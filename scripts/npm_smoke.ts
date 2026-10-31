#!/usr/bin/env -S deno run -A
/**
 * Checks the npm build the way Node and Bun users get it: builds and packs
 * `./npm`, installs the tarball into a temporary app (`tests/npm-smoke`),
 * type-checks that app against the published declarations, then renders its
 * pages and fetches their assets under Node (via tsx) and Bun, in memory
 * (`--none`), lazy (`--lazy`) and prebuilt (build, then serve) modes.
 *
 * Bun is skipped when it is not installed.
 *
 * Usage: deno task test:npm
 */

import { nodeCommand } from "./nodeCommand.ts";

const root = new URL("../", import.meta.url);
const fixtures = new URL("tests/npm-smoke/", root);
const npm = nodeCommand("npm");
const npx = nodeCommand("npx");

async function run(
  cmd: string,
  args: string[],
  cwd: string | URL,
  quiet = false,
): Promise<{ ok: boolean; output: string }> {
  const result = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: quiet ? "piped" : "inherit",
    stderr: quiet ? "piped" : "inherit",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    ok: result.code === 0,
    // Reading an inherited stream throws.
    output: quiet ? decode(result.stdout) + decode(result.stderr) : "",
  };
}

async function must(cmd: string, args: string[], cwd: string | URL) {
  const { ok } = await run(cmd, args, cwd);
  if (!ok) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

const hasBun = await run("bun", ["--version"], root, true).then(
  ({ ok }) => ok,
  () => false,
);

await must(Deno.execPath(), ["run", "-A", "scripts/build_npm.ts"], root);

const app = await Deno.makeTempDir({ prefix: "tinytools-npm-smoke-" });
console.log(`Smoke app in ${app}`);
await must(npm, ["pack", "--pack-destination", app], new URL("npm/", root));
const tarball =
  [...Deno.readDirSync(app)].find((entry) => entry.name.endsWith(".tgz"))!.name;

for (const entry of Deno.readDirSync(fixtures)) {
  await Deno.copyFile(new URL(entry.name, fixtures), `${app}/${entry.name}`);
}
await Deno.writeTextFile(
  `${app}/package.json`,
  JSON.stringify({
    name: "tinytools-npm-smoke",
    private: true,
    type: "module",
  }),
);
await Deno.writeTextFile(
  `${app}/tsconfig.json`,
  JSON.stringify({
    compilerOptions: {
      target: "esnext",
      module: "nodenext",
      moduleResolution: "nodenext",
      jsx: "react-jsx",
      jsxImportSource: "@tinyenterprise/hono-tools",
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      lib: ["esnext", "dom", "dom.iterable"],
      types: ["node"],
    },
  }),
);
await must(npm, [
  "install",
  "--no-audit",
  "--no-fund",
  `./${tarball}`,
  "hono",
  "@hono/node-server",
  "tsx",
  "typescript@^7",
  "@types/node@^24",
], app);

const results: [string, boolean, string][] = [];
const record = (
  name: string,
  { ok, output }: { ok: boolean; output: string },
) => {
  results.push([name, ok, output]);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

record("tsc (declarations)", await run(npx, ["tsc", "-p", "."], app, true));

const runtimes: [string, string, string[]][] = [
  ["node", npx, ["tsx"]],
  ...(hasBun ? [["bun", "bun", []] as [string, string, string[]]] : []),
];
for (const [name, cmd, prefix] of runtimes) {
  const clean = () =>
    Promise.all(
      ["public", ".cache"].map((dir) =>
        Deno.remove(`${app}/${dir}`, { recursive: true }).catch(() => {})
      ),
    );
  for (const mode of ["--none", "--lazy"]) {
    await clean();
    record(
      `${name} ${mode}`,
      await run(cmd, [...prefix, "smoke.tsx", mode], app, true),
    );
  }
  await clean();
  const build = await run(cmd, [...prefix, "build.tsx"], app, true);
  record(
    `${name} prebuilt`,
    build.ok ? await run(cmd, [...prefix, "smoke.tsx"], app, true) : build,
  );
}
if (!hasBun) console.log("skip bun (not installed)");

const failed = results.filter(([, ok]) => !ok);
for (const [name, , output] of failed) {
  console.log(`\n--- ${name} ---\n${output.trim()}`);
}
if (failed.length) Deno.exit(1);
await Deno.remove(app, { recursive: true });
