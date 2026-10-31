/**
 * The executable to spawn for a Node command such as `npm` or `npx`. On
 * Windows it is a `.cmd` script (Node's installer) or an `.exe` shim (some
 * version managers), and spawning needs the actual file, so this returns the
 * first one on PATH.
 */
export function nodeCommand(name: string): string {
  if (Deno.build.os !== "windows") return name;
  for (const dir of (Deno.env.get("PATH") ?? "").split(";")) {
    if (!dir) continue;
    for (const ext of [".exe", ".cmd"]) {
      const path = `${dir.replace(/\\$/, "")}\\${name}${ext}`;
      try {
        if (Deno.statSync(path).isFile) return path;
      } catch {
        // Not in this directory.
      }
    }
  }
  return `${name}.cmd`;
}
