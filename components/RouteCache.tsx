import type { PropsWithChildren } from "hono/jsx";

export type RouteCacheProps = {
  path: string;
  cachePrefix: string;
  partialId: string;
  redirectTo?: string;
};

export function RouteCache(
  props: PropsWithChildren<RouteCacheProps>,
) {
  return (
    <route-cache-seed hidden>
      <template
        path={props.path}
        method="get"
        data-tinytools-route-cache="true"
        data-nav-block
        data-spa-redirect={props.redirectTo}
      >
        <partial
          id={props.partialId}
          mode="replace"
          data-cache-id={`${props.cachePrefix}:${props.path}`}
          data-tinytools-local-template-source="runtime"
        >
          {props.children}
        </partial>
      </template>
    </route-cache-seed>
  );
}
