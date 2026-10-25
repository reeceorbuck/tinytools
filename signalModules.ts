/**
 * The signal runtime as browser modules, one per feature, so a page loads
 * only the parts its collections use: `tt-signal` (`Signal`, `signalsFrom`
 * and dependency tracking) always, and `tt-computed`, `tt-trigger` and
 * `tt-instance` (`perInstance`) only for collections whose factory takes
 * them. Each module is built from the runtime in `signals.ts` with
 * `toString()`, so the server runs exactly the code the browser gets.
 *
 * @module
 */

import { compactSource, sourceHash } from "./lifecycleElement.ts";
import {
  ComputedInstance,
  InstanceGroup,
  InstanceSignalHandle,
  perInstanceFor,
  readControl,
  sameValue,
  SignalInstance,
  signalsFrom,
  track,
  TriggerInstance,
  untracked,
  withScope,
} from "./signals.ts";

/** A function or class, shipped as its source. */
type RuntimeFunction = { toString(): string };

type RuntimeModule = {
  /** The file name, `tt-<name>_<hash>.js`, served from `/handlers/`. */
  readonly file: string;
  readonly source: string;
};

function runtimeModule(
  name: string,
  parts: {
    imports?: [RuntimeModule, string[]][];
    /** Module state the functions share, declared ahead of them. */
    state?: string;
    internal?: RuntimeFunction[];
    exported: RuntimeFunction[];
  },
): RuntimeModule {
  const source = [
    ...(parts.imports ?? []).map(([module, names]) =>
      `import { ${names.join(", ")} } from "./${module.file}";`
    ),
    parts.state ?? "",
    ...(parts.internal ?? []).map((part) => compactSource(part.toString())),
    ...parts.exported.map((part) => `export ${compactSource(part.toString())}`),
  ].filter(Boolean).join("\n") + "\n";
  return { file: `tt-${name}_${sourceHash(source)}.js`, source };
}

const signalModule = runtimeModule("signal", {
  state: "let tracking = null;",
  internal: [sameValue, readControl],
  exported: [track, untracked, SignalInstance, signalsFrom],
});

const computedModule = runtimeModule("computed", {
  imports: [[signalModule, ["SignalInstance", "track"]]],
  exported: [ComputedInstance],
});

const triggerModule = runtimeModule("trigger", {
  imports: [[signalModule, ["SignalInstance"]]],
  exported: [TriggerInstance],
});

const instanceModule = runtimeModule("instance", {
  imports: [[signalModule, ["SignalInstance", "untracked"]]],
  state: "let currentScope;",
  internal: [withScope, InstanceGroup],
  exported: [InstanceSignalHandle, perInstanceFor],
});

const modules = [signalModule, computedModule, triggerModule, instanceModule];

/** The signal runtime modules' sources, by file name (`tt-signal_….js`). */
export const signalRuntimeSources: ReadonlyMap<string, string> = new Map(
  modules.map((module) => [module.file, module.source]),
);

/** The signal runtime modules, by path, served by `tiny.middleware.core()`. */
export const signalRuntimeFiles: ReadonlyMap<string, string> = new Map(
  modules.map((module) => [`/handlers/${module.file}`, module.source]),
);

/** Where each member of `SignalTools` comes from. */
const toolSources = {
  Signal: [signalModule, "SignalInstance"],
  signalsFrom: [signalModule, "signalsFrom"],
  Computed: [computedModule, "ComputedInstance"],
  Trigger: [triggerModule, "TriggerInstance"],
  // Called with the collection's instance key (see `toolBinding`).
  perInstance: [instanceModule, "perInstanceFor"],
} as const satisfies Record<string, [RuntimeModule, string]>;

type ToolName = keyof typeof toolSources;

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolSources, name);
}

/**
 * The members a factory parameter destructures, with the local name of
 * each (`{ Signal, Computed: C }`), or undefined for any other parameter
 * (a plain name, defaults, nested patterns, rest), which gets every tool.
 */
function destructuredTools(
  parameter: string,
): Map<ToolName, string> | undefined {
  const pattern = /^\{([^{}=.]*)\}$/.exec(parameter.trim())?.[1];
  if (pattern === undefined) return undefined;
  const tools = new Map<ToolName, string>();
  for (const entry of pattern.split(",")) {
    if (!entry.trim()) continue;
    const match = /^\s*([$\w]+)\s*(?::\s*([$A-Z_a-z][$\w]*)\s*)?$/.exec(entry);
    if (!match || !isToolName(match[1])) return undefined;
    tools.set(match[1], match[2] ?? match[1]);
  }
  return tools;
}

/**
 * The module-level code giving a collection bundle the tools its factory
 * parameter names, importing only the runtime modules those come from:
 * `import { SignalInstance as Signal } from "./tt-signal_….js";`. A parameter
 * that does not destructure gets every tool as one object, `const <parameter>
 * = { ... }`; with no parameter at all (a factory the bundle calls rather
 * than inlines), `tools` is that object, to pass. Returns the code and the
 * runtime files it imports.
 */
export function signalToolsPrelude(
  parameter: string | undefined,
  instanceKey: string,
): { code: string; files: string[]; tools?: string } {
  if (parameter !== undefined && !parameter.trim()) {
    return { code: "", files: [] };
  }
  const destructured = parameter === undefined
    ? undefined
    : destructuredTools(parameter);
  const tools = destructured ??
    new Map(
      Object.keys(toolSources).map((name) => [
        name as ToolName,
        `__tiny_${name}`,
      ]),
    );
  const imports = new Map<RuntimeModule, string[]>();
  const declarations: string[] = [];
  for (const [tool, local] of tools) {
    const [module, exported] = toolSources[tool];
    const binding = tool === "perInstance" ? `__tiny_${exported}` : local;
    const specifier = exported === binding
      ? exported
      : `${exported} as ${binding}`;
    imports.set(module, [...imports.get(module) ?? [], specifier]);
    if (tool === "perInstance") {
      declarations.push(
        `const ${local} = ${binding}(${JSON.stringify(instanceKey)});`,
      );
    }
  }
  const object = destructured
    ? undefined
    : `{ ${
      [...tools].map(([tool, local]) => `${tool}: ${local}`).join(", ")
    } }`;
  if (object && parameter !== undefined) {
    declarations.push(`const ${parameter} = ${object};`);
  }
  return {
    code: [
      ...[...imports].map(([module, specifiers]) =>
        `import { ${specifiers.join(", ")} } from "./${module.file}";`
      ),
      ...declarations,
    ].join("\n"),
    files: [...imports.keys()].map((module) => module.file),
    tools: parameter === undefined ? object : undefined,
  };
}
