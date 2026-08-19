import type { PropsWithChildren } from "hono/jsx";
import { tiny } from "@tinytools/hono-tools";
import { partialInsertHandlers } from "@tinytools/hono-tools/partial-insert-handlers";
import type { PartialContentElement } from "../client/wc-partialContent.ts";
import type { ActivatedClientFunction } from "../jsx-runtime.ts";

export type RouteCacheProps = {
  path: string;
  cachePrefix: string;
  partialId: string;
  redirectTo?: string;
  onMount?: ActivatedClientFunction<
    (this: PartialContentElement, element: PartialContentElement) => void
  >;
};

export async function RouteCache(
  props: PropsWithChildren<RouteCacheProps>,
) {
  const mountHandler = props.onMount ??
    (await tiny.imports(partialInsertHandlers)).fn.partialReplace;
  return (
    <route-cache-seed hidden>
      <template
        path={props.path}
        method="get"
        data-tinytools-route-cache="true"
        data-nav-block
        data-spa-redirect={props.redirectTo}
      >
        <partial-content
          id={props.partialId}
          onMount={mountHandler}
          data-cache-id={`${props.cachePrefix}:${props.path}`}
          data-tinytools-local-template-source="runtime"
        >
          {props.children}
        </partial-content>
      </template>
    </route-cache-seed>
  );
}
