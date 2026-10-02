import { getContext } from "hono/context-storage";
import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { Handlers } from "../clientTools.ts";
import { tiny } from "../honoFactory.tsx";
import { routeCacheTools } from "../handlers/routeCacheTools.ts";
import type { ActivatedClientFunction, JSX } from "../jsx-runtime.ts";
import type { HandlerReference } from "../eventAttributes.ts";
import { PartialCacheRoutes } from "./ClientRoutes.tsx";
import { UpgradeCustomElement } from "./ActivateOnLoadHandler.tsx";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";
import { transparent } from "../componentScope.ts";
import { getDisplayedPath } from "../sse.ts";

const partialLogic = new Handlers(import.meta.url, {
  /** Fires `load` on the preceding `<template>` so its insertion handler runs. */
  passLoadEvent: function (this: HTMLElement): void {
    const precedingTemplate = this.previousElementSibling;
    if (precedingTemplate?.tagName === "TEMPLATE") {
      precedingTemplate.dispatchEvent(new Event("load"));
      this.remove();
    } else {
      console.error("passLoadEvent: no preceding template found.");
    }
  },
});

/** The modulepreload link that triggers a partial template's insertion handler. */
function passLoadEventHref(): string {
  return `/handlers/${partialLogic._handlerFilenames.get("passLoadEvent")}.js`;
}

type PartialInsertHandler =
  | HandlerReference<
    string,
    (this: HTMLTemplateElement, event: Event) => void
  >
  | ActivatedClientFunction<
    (this: HTMLTemplateElement, event: Event) => void
  >;

export type PartialProps = PropsWithChildren<{
  /** Insertion handler run when the partial's template loads, e.g. `fn.partialReplace`. */
  onLoad: PartialInsertHandler;
  /** The `id` of the live element the partial targets. */
  id?: string;
  /** Group name for `partialMergeContent` matching. */
  groupName?: string;
  /** `true` caches under the request path; a string gives the URLPattern to cache under. */
  cache?: boolean | string;
  /**
   * Path that server update patterns are tested against while this content
   * is cached. Defaults to the page path the content is displayed under.
   */
  updatePath?: string;
  /** Render the children in place (the layout already placed them in the target). */
  fullPageLoad?: boolean;
  [attribute: string]: unknown;
}>;

/**
 * Declares a partial page update: a `<template for-partial-id>` holding the
 * children plus a modulepreload trigger that runs `onLoad` once it arrives.
 */
export async function NewPartial(
  props: PartialProps,
): Promise<HtmlEscapedString> {
  const {
    onLoad,
    groupName,
    children,
    id,
    cache = false,
    updatePath,
    fullPageLoad = false,
    ...attributes
  } = props;
  const context = cache ? getContext() : undefined;
  const cachePath = context?.req.path;
  const cacheUpdatePath = context
    ? updatePath ?? getDisplayedPath(context)
    : undefined;
  const cachePattern = typeof cache === "string"
    ? cache
    : cachePath?.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const { fn } = await tiny.imports(partialLogic, routeCacheTools);

  const content = (
    <>
      {children}
      {cache && (
        <UpgradeCustomElement>
          <cache-collector
            hidden
            onLoad={fn.observeRouteCache}
            cache-partial-id={id}
          >
            <template>
              <client-route
                path={cachePattern}
                update-path={cacheUpdatePath}
                once
                data-nav-block
                interpolate="false"
              >
                <template
                  onLoad={onLoad}
                  for-partial-id={id}
                  group-name={groupName}
                  {...attributes}
                >
                </template>
                <link
                  rel="modulepreload"
                  href={passLoadEventHref()}
                  onLoad={fn.passLoadEvent}
                />
              </client-route>
              <PartialCacheRoutes ownerId={id} />
            </template>
          </cache-collector>
        </UpgradeCustomElement>
      )}
    </>
  );

  if (fullPageLoad) return content;

  return (
    <>
      <template
        onLoad={onLoad}
        group-name={groupName}
        for-partial-id={id}
        {...attributes}
      >
        {content}
      </template>
      <link
        rel="modulepreload"
        href={passLoadEventHref()}
        onLoad={fn.passLoadEvent}
      />
    </>
  );
}

/**
 * Replaces the children of `#id` (or the element itself with
 * `includeWrapper`) with this partial's children.
 */
export const PartialReplace = async function (
  props: PropsWithChildren<{
    id: string;
    fullPageLoad?: boolean;
    /** Replace the target element itself rather than its children. */
    includeWrapper?: boolean;
    cache?: boolean | string;
    updatePath?: string;
  }>,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(partialInsertHandlers);
  return (
    <NewPartial
      id={props.id}
      fullPageLoad={props.fullPageLoad}
      onLoad={props.includeWrapper ? fn.partialBlast : fn.partialReplace}
      {...props.cache ? { cache: props.cache } : {}}
      {...props.updatePath ? { updatePath: props.updatePath } : {}}
    >
      {props.children}
    </NewPartial>
  );
};

/** A `PartialReplace` whose outgoing content is cached for client-side restoration. */
export const PartialReplaceWithCache = function (
  props: PropsWithChildren<{
    /** URLPattern to cache under; defaults to the request path. */
    path?: string;
    /** Path matched by server update patterns while cached. */
    updatePath?: string;
    id: string;
    fullPageLoad?: boolean;
    includeWrapper?: boolean;
  }>,
): JSX.Element {
  return (
    <PartialReplace
      id={props.id}
      cache={props.path ?? true}
      updatePath={props.updatePath}
      fullPageLoad={props.fullPageLoad}
      includeWrapper={props.includeWrapper}
    >
      {props.children}
    </PartialReplace>
  );
};

/** Removes `#id` from the page. */
export const PartialDelete = async function (
  props: { id: string },
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(partialInsertHandlers);
  return (
    <NewPartial
      id={props.id}
      onLoad={fn.partialDelete}
    >
    </NewPartial>
  );
};

// Framework wrappers render into the caller's component scope.
transparent(NewPartial);
transparent(PartialReplace);
transparent(PartialReplaceWithCache);
transparent(PartialDelete);
