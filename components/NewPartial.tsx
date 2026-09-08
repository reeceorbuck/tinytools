import { getContext } from "hono/context-storage";
import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { Handlers } from "../clientTools.ts";
import { tiny } from "../honoFactory.tsx";
import { routeCacheTools } from "../handlers/routeCacheTools.ts";
import type { ActivatedClientFunction } from "../jsx-runtime.ts";
import { ClientRoutes } from "./ClientRoutes.tsx";

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

type PartialInsertHandler = ActivatedClientFunction<
  (this: HTMLTemplateElement, event: Event) => void
>;

export async function NewPartial(
  props: PropsWithChildren<{
    onLoad: PartialInsertHandler;
    id?: string;
    groupName?: string;
    cache?: boolean | string;
    [attribute: string]: unknown;
  }>,
): Promise<HtmlEscapedString> {
  const { onLoad, groupName, children, id, cache = false, ...attributes } =
    props;
  const cachePath = cache ? getContext().req.path : undefined;
  const cachePattern = typeof cache === "string"
    ? cache
    : cachePath?.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const { fn } = await tiny.imports(partialLogic, routeCacheTools);

  return (
    <>
      <template
        onLoad={onLoad}
        group-name={groupName}
        for-partial-id={id}
        {...attributes}
      >
        {children}
        {cache && (
          <>
            <template
              onLoad={fn.registerRouteCache}
              for-partial-id={id}
              path={cachePath}
            >
              <client-route
                path={cachePattern}
                from-partial-id={id}
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
              <ClientRoutes />
            </template>
            <link
              rel="modulepreload"
              href={`/handlers/${
                partialLogic._handlerFilenames.get("passLoadEvent")
              }.js`}
              onLoad={fn.passLoadEvent}
            />
          </>
        )}
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
