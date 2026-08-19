export interface PartialContentProcessingOptions {
  cacheCurrentPath?: string;
  activeRoutePath?: string;
  activeRouteRegistrations?: Array<{
    pathname: string;
    redirectTo?: string;
  }>;
  updateCachedTemplates?: boolean;
  bypassRouteCache?: boolean;
  navGeneration?: number;
}

export interface PartialContentContext {
  readonly scope: ParentNode;
  readonly options: PartialContentProcessingOptions;
  readonly incomingElements: readonly Element[];
  readonly state: Set<string>;
}

const contextKey = Symbol.for("tinytools.partialContentContexts");
const contextGlobal = globalThis as typeof globalThis & {
  [contextKey]?: WeakMap<Element, PartialContentContext>;
};
const contexts = contextGlobal[contextKey] ??= new WeakMap();

export function setPartialContentContext(
  element: Element,
  context: PartialContentContext,
) {
  contexts.set(element, context);
}

export function getPartialContentContext(element: Element) {
  return contexts.get(element);
}
