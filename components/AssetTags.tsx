import type { FC } from "hono/jsx";
import { tryGetContext } from "hono/context-storage";

/** URL prefix for package-provided client scripts */
const P = "/_tinytools";

type AssetTagsProps = {
  /** Whether to include full page load scripts (navigation, updates, etc.)
   * @default true
   */
  fullPageLoad?: boolean;
  /** Optional explicit handler assets (e.g. for non-request update rendering) */
  accessedHandlerFiles?: Iterable<string>;
  /** Optional explicit style assets (e.g. for non-request update rendering) */
  accessedStyleFiles?: Iterable<string>;
};

/**
 * Renders script and link tags for handler and style assets, along with
 * client-side scripts for enabled features.
 *
 * Feature scripts are controlled by the `tinyToolsFeatures` context set,
 * populated by individual feature middleware (e.g. `tiny.middleware.navApiTools()`).
 *
 * Features and their scripts:
 * - `"navigation"` - navigation.js, processIncomingData.js, processIncomingHtml.js,
 *                     performFetchAndUpdate.js, eventHandlers.js
 * - `"sse"` - sse.js
 * - `"localRoutes"` - localRoutes.js
 * - `"webComponents"` - wc-lifecycleElement.js, wc-windowEventlistener.js
 *
 * @example
 * ```tsx
 * // Scripts are determined by which feature middleware is active
 * <AssetTags />
 *
 * // For partial nav / SSE updates (no framework scripts)
 * <AssetTags fullPageLoad={false} />
 * ```
 */
export const AssetTags: FC<AssetTagsProps> = ({
  fullPageLoad = true,
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
    console.log(
      "[AssetTags] Reading accessedStyleFiles:",
      Array.from(accessedStyleFiles),
    );
    const accessedHandlerFiles = c?.var?.accessedHandlerFiles as Set<string> ||
      new Set<string>();

    accessedStyleFilesArray = Array.from(accessedStyleFiles);
    accessedStyleFiles.clear();

    accessedHandlerFilesArray = Array.from(accessedHandlerFiles);
    accessedHandlerFiles.clear();
  }

  // Read enabled features from context (populated by feature middleware)
  const features = c?.var?.tinyToolsFeatures as Set<string> | undefined;
  const hasNavigation = features?.has("navigation") ?? false;
  const hasSse = features?.has("sse") ?? false;
  const hasLocalRoutes = features?.has("localRoutes") ?? false;
  const hasWebComponents = features?.has("webComponents") ?? false;

  return (
    <>
      {/* Navigation and partial page update scripts */}
      {fullPageLoad && hasNavigation && (
        <>
          <script src={`${P}/navigation.js`} type="module" />
          <script src={`${P}/processIncomingData.js`} type="module" />
          <script src={`${P}/processIncomingHtml.js`} type="module" />
          <script src={`${P}/performFetchAndUpdate.js`} type="module" />
        </>
      )}

      {/* Server-Sent Events for live updates */}
      {fullPageLoad && hasSse && <script src={`${P}/sse.js`} type="module" />}

      {/* Client-side template routing */}
      {fullPageLoad && hasLocalRoutes && (
        <script src={`${P}/localRoutes.js`} type="module" />
      )}

      {/* Web components for lifecycle and window events */}
      {fullPageLoad && hasWebComponents && (
        <>
          <script src={`${P}/wc-lifecycleElement.js`} defer />
          <script src={`${P}/wc-windowEventlistener.js`} defer />
        </>
      )}

      {/* User-defined handler scripts */}
      {accessedHandlerFilesArray.map((file) => (
        <script src={`/handlers/${file}`} type="module" />
      ))}

      {/* User-defined stylesheets */}
      {accessedStyleFilesArray.map((file) => (
        <link
          rel="stylesheet"
          href={`/styles/${file}`}
        />
      ))}

      {/* Event handler proxy for lazy-loading user handlers */}
      {fullPageLoad && hasNavigation && (
        <script
          src={`${P}/eventHandlers.js`}
        />
      )}
    </>
  );
};
