#!/usr/bin/env -S deno run -A
/**
 * Releases a new version of the package through CI. Bumps the version in
 * `deno.json` and `package.json`, checks that it would publish, then commits
 * and pushes to main. The Publish workflow (`.github/workflows/publish.yml`)
 * publishes the pushed version to JSR and npm with provenance.
 *
 * Works in any clone of the package. The tinyTools monorepo's
 * `deno task release:patch` runs this, then syncs the apps to the release.
 *
 * The working tree must be clean, so the release commit holds only the
 * release.
 *
 * Options:
 * - `--update-deps`: update the package's dependencies to their latest
 *   versions first, as part of the release commit.
 * - `--wait`: wait until the version is live on JSR and npm.
 *
 * Usage: deno task release [patch|minor|major] [--update-deps] [--wait]
 */

const root = new URL("../", import.meta.url);
const increment = Deno.args.find((arg) => !arg.startsWith("--")) ?? "patch";
const updateDeps = Deno.args.includes("--update-deps");
const wait = Deno.args.includes("--wait");
const PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;

if (!["patch", "minor", "major"].includes(increment)) {
  console.error(`Unknown increment "${increment}": use patch, minor or major`);
  Deno.exit(1);
}

async function run(cmd: string, args: string[]): Promise<string> {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const { code, stdout } = await new Deno.Command(cmd, {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  const text = new TextDecoder().decode(stdout);
  if (code !== 0) {
    console.log(text);
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${code}`);
  }
  return text;
}

const readJson = async (path: string) =>
  JSON.parse(await Deno.readTextFile(new URL(path, root)));

// CI only publishes from main.
const branch = (await run("git", ["branch", "--show-current"])).trim();
if (branch !== "main") {
  console.error(`On branch "${branch}": releases are pushed from main`);
  Deno.exit(1);
}

const dirty = await run("git", ["status", "--porcelain"]);
if (dirty.trim()) {
  console.error(`Uncommitted changes. Commit them first:\n${dirty}`);
  Deno.exit(1);
}

// No lockfile: the package does not track one (a monorepo's root lockfile
// is updated by its own release). @types/node stays on the major of the
// Node version the package supports (`engines` in package.json).
if (updateDeps) {
  await run(Deno.execPath(), [
    "update",
    "--latest",
    "--minimum-dependency-age",
    "0",
    "--no-lock",
    "!@types/node",
  ]);
}

await run(Deno.execPath(), ["bump-version", increment, "--no-workspace"]);

const { version, name: jsrName } = await readJson("deno.json");
const { name: npmName } = await readJson("package.json");

// Replace only the version, keeping the file's own formatting.
const packageJsonUrl = new URL("package.json", root);
const packageJson = await Deno.readTextFile(packageJsonUrl);
await Deno.writeTextFile(
  packageJsonUrl,
  packageJson.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`),
);

// Catch what would fail in CI before anything is pushed.
await run(Deno.execPath(), ["publish", "--dry-run", "--allow-dirty"]);

await run("git", ["add", "-A"]);
await run("git", ["commit", "-m", `chore: release v${version}`]);
await run("git", ["push", "origin", "HEAD"]);

console.log(
  `Pushed v${version}. CI publishes it to JSR and npm: ` +
    "https://github.com/reeceorbuck/tinytools/actions/workflows/publish.yml",
);
if (!wait) Deno.exit(0);

const registries = {
  JSR: `https://jsr.io/${jsrName}/meta.json`,
  npm: `https://registry.npmjs.org/${npmName.replace("/", "%2f")}`,
};

const deadline = Date.now() + PUBLISH_TIMEOUT_MS;
for (const [registry, url] of Object.entries(registries)) {
  console.log(`Waiting for v${version} on ${registry}...`);
  while (true) {
    const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    const meta = res.ok ? await res.json() : {};
    if (meta.versions?.[version]) break;
    if (Date.now() > deadline) {
      console.error(
        `v${version} is not on ${registry} after ${
          PUBLISH_TIMEOUT_MS / 60000
        } minutes. Check the Publish workflow.`,
      );
      Deno.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.log(`v${version} is live on ${registry}.`);
}
