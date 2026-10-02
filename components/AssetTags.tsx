import type { FC } from "hono/jsx";
import { tryGetContext } from "hono/context-storage";
import { transparent } from "../componentScope.ts";
import { handlerFileDependencies } from "../clientFunctions.ts";

type AssetTagsProps = {
  /** Optional explicit handler assets (e.g. for non-request update rendering) */
  accessedHandlerFiles?: Iterable<string>;
  /** Optional explicit style assets (e.g. for non-request update rendering) */
  accessedStyleFiles?: Iterable<string>;
};

/**
 * Renders accessed handler and style assets.
 *
 * @example
 * ```tsx
 * <AssetTags />
 * ```
 */
export const AssetTags: FC<AssetTagsProps> = ({
  accessedHandlerFiles: explicitHandlerFiles,
  accessedStyleFiles: explicitStyleFiles,
}) => {
  let accessedStyleFilesArray: string[];
  let accessedHandlerFilesArray: string[];

  // deno-lint-ignore no-explicit-any
  const c = tryGetContext() as any;

  if (explicitHandlerFiles || explicitStyleFiles) {
    accessedHandlerFilesArray = Array.from(explicitHandlerFiles ?? []);
    accessedStyleFilesArray = Array.from(explicitStyleFiles ?? []);
  } else {
    // These are set internally by the tools middleware initialized by tiny.middleware.core()
    const accessedStyleFiles = c?.var?.accessedStyleFiles as Set<string> ||
      new Set<string>();
    const accessedHandlerFiles = c?.var?.accessedHandlerFiles as Set<string> ||
      new Set<string>();

    accessedStyleFilesArray = Array.from(accessedStyleFiles);
    accessedStyleFiles.clear();

    accessedHandlerFilesArray = Array.from(accessedHandlerFiles);
    accessedHandlerFiles.clear();
  }

  return (
    <>
      {/* User-defined handler scripts */}
      {accessedHandlerFilesArray.map((file) => (
        <script src={`/handlers/${file}`} type="module" />
      ))}

      {
        /* Bundles those scripts import, fetched in parallel rather than
          discovered one import level per round trip. */
      }
      {handlerFileDependencies(accessedHandlerFilesArray).map((file) => (
        <link rel="modulepreload" href={`/handlers/${file}`} />
      ))}

      {/* User-defined stylesheets */}
      {accessedStyleFilesArray.map((file) => (
        <link
          rel="stylesheet"
          href={`/styles/${file}`}
        />
      ))}
    </>
  );
};

// Framework wrappers render into the caller's component scope.
transparent(AssetTags);
