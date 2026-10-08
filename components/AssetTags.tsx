import { tryGetContext } from "hono/context-storage";
import { transparent } from "../componentScope.ts";
import {
  handlerFileDependencies,
  styleFileDependencies,
} from "../clientFunctions.ts";
import {
  LIFECYCLE_TAG_DECLARATION,
  lifecycleRuntimeScript,
} from "../lifecycleElement.ts";
import { raw } from "hono/html";
import type { JSX } from "../jsx-runtime.ts";

type AssetTagsProps = {
  /** Handler bundle files (`<name>.js`) to load; defaults to the request's accessed handlers. */
  accessedHandlerFiles?: Iterable<string>;
  /** Stylesheet files (`<name>.css`) to load; defaults to the request's accessed styles. */
  accessedStyleFiles?: Iterable<string>;
  /** Custom tags to define as lifecycle elements; defaults to the request's accessed tags. */
  accessedLifecycleTags?: Iterable<string>;
  /**
   * How lifecycle tags are declared: `meta` inside a full page's `<head>`,
   * where the inline head script defines them as it runs; `element` (the
   * default) anywhere else, as `<tt-define>` elements that define their tag
   * the moment they connect. The head cannot hold custom elements.
   */
  defineWith?: "meta" | "element";
};

type AssetContext = {
  var?: {
    accessedHandlerFiles?: Set<string>;
    accessedStyleFiles?: Set<string>;
    accessedLifecycleTags?: Set<string>;
  };
};

/** Context variable set once a response has carried the lifecycle runtime. */
export const LIFECYCLE_RUNTIME_SENT_KEY = "tinyToolsLifecycleRuntimeSent";

/**
 * Declares custom tags for the lifecycle runtime to define as lifecycle
 * elements (see `lifecycleElement.ts`). Rendered ahead of the markup that
 * uses the tags, so they are defined before that markup is parsed or
 * inserted. `<tt-define>` declarations are preceded by the runtime itself,
 * inline, unless this response already carried it: the page they land on
 * may not have it yet, and a copy it already has does nothing. `withRuntime`
 * overrides that check, for content rendered outside the response it
 * reaches (pushed updates).
 */
export function LifecycleTags(
  { tags, defineWith = "element", withRuntime }: {
    tags: Iterable<string>;
    defineWith?: "meta" | "element";
    withRuntime?: boolean;
  },
): JSX.Element {
  const unique = [...new Set(tags)];
  let runtime = false;
  if (unique.length && defineWith === "element") {
    runtime = withRuntime ?? true;
    if (withRuntime === undefined) {
      const context = tryGetContext();
      if (context?.get(LIFECYCLE_RUNTIME_SENT_KEY as never)) runtime = false;
      else context?.set(LIFECYCLE_RUNTIME_SENT_KEY as never, true as never);
    }
  }
  return (
    <>
      {runtime && <script>{raw(lifecycleRuntimeScript)}</script>}
      {unique.map((tag) =>
        defineWith === "meta"
          ? <meta key={tag} name={LIFECYCLE_TAG_DECLARATION} content={tag} />
          : <tt-define key={tag} tag={tag}></tt-define>
      )}
    </>
  );
}

/**
 * Renders the lifecycle tag declarations, script, modulepreload and
 * stylesheet tags for the assets a render accessed. Without explicit props
 * the request's tracked sets are used and then cleared, so later renders in
 * the same request (such as streamed Suspense content) only emit new assets.
 */
export function AssetTags({
  accessedHandlerFiles: explicitHandlerFiles,
  accessedStyleFiles: explicitStyleFiles,
  accessedLifecycleTags: explicitLifecycleTags,
  defineWith,
}: AssetTagsProps): JSX.Element {
  let handlerFiles: string[];
  let styleFiles: string[];
  let lifecycleTags: string[];

  if (explicitHandlerFiles || explicitStyleFiles || explicitLifecycleTags) {
    handlerFiles = Array.from(explicitHandlerFiles ?? []);
    styleFiles = Array.from(explicitStyleFiles ?? []);
    lifecycleTags = Array.from(explicitLifecycleTags ?? []);
  } else {
    // Set by tiny.middleware.core() for every request.
    const context = tryGetContext() as AssetContext | undefined;
    const accessedStyleFiles = context?.var?.accessedStyleFiles ?? new Set();
    const accessedHandlerFiles = context?.var?.accessedHandlerFiles ??
      new Set();
    const accessedLifecycleTags = context?.var?.accessedLifecycleTags ??
      new Set();
    styleFiles = Array.from(accessedStyleFiles);
    accessedStyleFiles.clear();
    handlerFiles = Array.from(accessedHandlerFiles);
    accessedHandlerFiles.clear();
    lifecycleTags = Array.from(accessedLifecycleTags);
    accessedLifecycleTags.clear();
  }

  return (
    <>
      <LifecycleTags tags={lifecycleTags} defineWith={defineWith} />
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
      {/* Stylesheets for the markup of templates those handlers clone. */}
      {styleFileDependencies(handlerFiles, styleFiles).map((file) => (
        <link rel="stylesheet" href={`/styles/${file}`} />
      ))}
    </>
  );
}

// Framework wrappers render into the caller's component scope.
transparent(LifecycleTags);
transparent(AssetTags);
