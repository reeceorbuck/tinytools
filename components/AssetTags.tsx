import { tryGetContext } from "hono/context-storage";
import { transparent } from "../componentScope.ts";
import { handlerFileDependencies } from "../clientFunctions.ts";
import type { JSX } from "../jsx-runtime.ts";

type AssetTagsProps = {
  /** Handler bundle files (`<name>.js`) to load; defaults to the request's accessed handlers. */
  accessedHandlerFiles?: Iterable<string>;
  /** Stylesheet files (`<name>.css`) to load; defaults to the request's accessed styles. */
  accessedStyleFiles?: Iterable<string>;
};

type AssetContext = {
  var?: {
    accessedHandlerFiles?: Set<string>;
    accessedStyleFiles?: Set<string>;
  };
};

/**
 * Renders the script, modulepreload and stylesheet tags for the handler
 * bundles and style bundles a render accessed. Without explicit props the
 * request's tracked sets are used and then cleared, so later renders in the
 * same request (such as streamed Suspense content) only emit new assets.
 */
export function AssetTags({
  accessedHandlerFiles: explicitHandlerFiles,
  accessedStyleFiles: explicitStyleFiles,
}: AssetTagsProps): JSX.Element {
  let handlerFiles: string[];
  let styleFiles: string[];

  if (explicitHandlerFiles || explicitStyleFiles) {
    handlerFiles = Array.from(explicitHandlerFiles ?? []);
    styleFiles = Array.from(explicitStyleFiles ?? []);
  } else {
    // Set by tiny.middleware.core() for every request.
    const context = tryGetContext() as AssetContext | undefined;
    const accessedStyleFiles = context?.var?.accessedStyleFiles ?? new Set();
    const accessedHandlerFiles = context?.var?.accessedHandlerFiles ??
      new Set();
    styleFiles = Array.from(accessedStyleFiles);
    accessedStyleFiles.clear();
    handlerFiles = Array.from(accessedHandlerFiles);
    accessedHandlerFiles.clear();
  }

  return (
    <>
      {handlerFiles.map((file) => (
        <script src={`/handlers/${file}`} type="module" />
      ))}
      {/* Bundles those scripts import, fetched in parallel rather than one import level per round trip. */}
      {handlerFileDependencies(handlerFiles).map((file) => (
        <link rel="modulepreload" href={`/handlers/${file}`} />
      ))}
      {styleFiles.map((file) => (
        <link rel="stylesheet" href={`/styles/${file}`} />
      ))}
    </>
  );
}

// Framework wrappers render into the caller's component scope.
transparent(AssetTags);
