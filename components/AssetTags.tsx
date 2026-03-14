import type { FC } from "hono/jsx";
import { tryGetContext } from "hono/context-storage";

/** URL prefix for package-provided client scripts */
const P = "/_tinytools";

type AssetTagsProps = {
  /** Whether to include full page load scripts (navigation, updates, etc.)
   * @default true
   */
  fullPageLoad?: boolean;
  /**
   * Whether to include essential client-side scripts for navigation and updates.
   * These are required for SPA-like navigation and partial page updates to work.
   * @default true
   */
  essentials?: boolean;
  /**
   * Whether to include the SSE (Server-Sent Events) script for live updates.
   * @default true
   */
  sse?: boolean;
  /**
   * Whether to include the local routes script for client-side template routing.
   * @default true
   */
  localRoutes?: boolean;
  /**
   * Whether to include web component scripts (lifecycle-element, window-event-listener).
   * @default true
   */
  webComponents?: boolean;
  /** Optional explicit handler assets (e.g. for non-request update rendering) */
  accessedHandlerFiles?: Iterable<string>;
  /** Optional explicit style assets (e.g. for non-request update rendering) */
  accessedStyleFiles?: Iterable<string>;
};

/**
 * Renders script and link tags for handler and style assets, along with essential
 * client-side scripts required for the framework to function.
 *
 * Essential scripts (included by default):
 * - navigation.js - Handles client-side navigation
 * - processIncomingData.js - Processes incoming data from server
 * - processIncomingHtml.js - Processes incoming HTML updates
 * - performFetchAndUpdate.js - Performs fetch requests and DOM updates
 * - eventHandlers.js - Manages event handler delegation
 *
 * Optional scripts (included by default, can be disabled):
 * - sse.js - Server-Sent Events for live updates
 * - localRoutes.js - Client-side template routing
 * - wc-lifecycleElement.js - Web component for lifecycle events
 * - wc-windowEventlistener.js - Web component for window event listeners
 *
 * @example
 * // Include all scripts (default)
 * <AssetTags />
 *
 * @example
 * // Disable SSE and local routes
 * <AssetTags sse={false} localRoutes={false} />
 */
export const AssetTags: FC<AssetTagsProps> = ({
  fullPageLoad = true,
  essentials = true,
  sse = true,
  localRoutes = true,
  webComponents = true,
  accessedHandlerFiles: explicitHandlerFiles,
  accessedStyleFiles: explicitStyleFiles,
}) => {
  let accessedStyleFilesArray: string[];
  let accessedHandlerFilesArray: string[];

  if (explicitHandlerFiles || explicitStyleFiles) {
    accessedHandlerFilesArray = Array.from(explicitHandlerFiles ?? []);
    accessedStyleFilesArray = Array.from(explicitStyleFiles ?? []);
  } else {
    // These are set internally by the tools middleware initialized by addTinyTools
    // deno-lint-ignore no-explicit-any
    const c = tryGetContext() as any;
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
  return (
    <>
      {/* Essential scripts for navigation and page updates */}
      {fullPageLoad && essentials && (
        <>
          <script src={`${P}/navigation.js`} type="module" />
          <script src={`${P}/processIncomingData.js`} type="module" />
          <script src={`${P}/processIncomingHtml.js`} type="module" />
          <script src={`${P}/performFetchAndUpdate.js`} type="module" />
        </>
      )}

      {/* Optional: Server-Sent Events for live updates */}
      {fullPageLoad && sse && <script src={`${P}/sse.js`} type="module" />}

      {/* Optional: Client-side template routing */}
      {fullPageLoad && localRoutes && (
        <script src={`${P}/localRoutes.js`} type="module" />
      )}

      {/* Optional: Web components for lifecycle and window events */}
      {fullPageLoad && webComponents && (
        <>
          <script src={`${P}/wc-lifecycleElement.js`} async />
          <script src={`${P}/wc-windowEventlistener.js`} async />
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

      {/* Event handler delegation and scoped style injection (must come after handlers) */}
      {fullPageLoad && essentials && (
        <>
          <script src={`${P}/eventHandlers.js`} />
        </>
      )}
    </>
  );
};
