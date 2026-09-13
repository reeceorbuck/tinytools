/**
 * Optional Components module for @tinytools/hono-tools
 *
 * Provides Suspense and Partial components for streaming and partial page updates.
 *
 * @module
 */

export { AssetTags } from "./AssetTags.tsx";
export { ClientRoutes } from "./ClientRoutes.tsx";
export {
  ActivateLifecycleHandlers,
  ActivateOnLoadHandler,
  BuildFromTemplateElement,
} from "./ActivateOnLoadHandler.tsx";
export { CustomSuspense, Suspense } from "./Suspense.tsx";
export type { CustomSuspenseProps, SuspenseProps } from "./Suspense.tsx";
// export { Partial } from "./Partial.tsx";
export {
  NewPartial,
  PartialDelete,
  PartialReplace,
  PartialReplaceWithCache,
} from "./NewPartial.tsx";
export type { PartialProps } from "../clientArchive/Partial.tsx";
