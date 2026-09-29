import { getContext } from "hono/context-storage";
import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { Handlers } from "../clientTools.ts";
import { tiny } from "../honoFactory.tsx";
import { routeCacheTools } from "../handlers/routeCacheTools.ts";
import type { ActivatedClientFunction } from "../jsx-runtime.ts";
import type { HandlerReference } from "../eventAttributes.ts";
import { PartialCacheRoutes } from "./ClientRoutes.tsx";
import { UpgradeCustomElement } from "./ActivateOnLoadHandler.tsx";
import { partialInsertHandlers } from "../handlers/partialInsertHandlers.ts";

const partialLogic = new Handlers(import.meta.url, {
  passLoadEvent: function (this: HTMLElement) {
    const precedingTemplate = this.previousElementSibling;
    if (precedingTemplate && precedingTemplate.tagName === "TEMPLATE") {
      precedingTemplate.dispatchEvent(new Event("load"));
      this.remove();
    } else {
      console.error(
        "No preceding template found for loadPartialTemplate handler.",
      );
    }
  },
});

type PartialInsertHandler =
  | HandlerReference<
    string,
    (this: HTMLTemplateElement, event: Event) => void
  >
  | ActivatedClientFunction<
    (this: HTMLTemplateElement, event: Event) => void
  >;

export type PartialProps = PropsWithChildren<{
  onLoad: PartialInsertHandler;
  id?: string;
  groupName?: string;
  cache?: boolean | string;
  fullPageLoad?: boolean;
  [attribute: string]: unknown;
}>;

export async function NewPartial(
  props: PartialProps,
): Promise<HtmlEscapedString> {
  const {
    onLoad,
    groupName,
    children,
    id,
    cache = false,
    fullPageLoad = false,
    ...attributes
  } = props;
  const cachePath = cache ? getContext().req.path : undefined;
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
                  href={`/handlers/${
                    partialLogic._handlerFilenames.get("passLoadEvent")
                  }.js`}
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
        href={`/handlers/${
          partialLogic._handlerFilenames.get("passLoadEvent")
        }.js`}
        onLoad={fn.passLoadEvent}
      />
    </>
  );
}

export const PartialReplace = async function (
  props: PropsWithChildren<{
    id: string;
    fullPageLoad?: boolean;
    includeWrapper?: boolean;
    cache?: boolean | string;
  }>,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(partialInsertHandlers);
  return (
    <NewPartial
      id={props.id}
      fullPageLoad={props.fullPageLoad}
      onLoad={props.includeWrapper ? fn.partialBlast : fn.partialReplace}
      {...props.cache ? { cache: props.cache } : {}}
    >
      {props.children}
    </NewPartial>
  );
};

export const PartialReplaceWithCache = function (
  props: PropsWithChildren<{
    path?: string;
    id: string;
    fullPageLoad?: boolean;
    includeWrapper?: boolean;
  }>,
) {
  return (
    <PartialReplace
      id={props.id}
      cache={props.path ?? true}
      fullPageLoad={props.fullPageLoad}
      includeWrapper={props.includeWrapper}
    >
      {props.children}
    </PartialReplace>
  );
};

export const PartialDelete = async function (
  props: {
    id: string;
  },
) {
  const { fn } = await tiny.imports(partialInsertHandlers);
  return (
    <NewPartial
      id={props.id}
      onLoad={fn.partialDelete}
    >
    </NewPartial>
  );
};
