/**
 * Partial Component for @tinytools/hono-tools
 *
 * Provides a component for declaring partial page update regions.
 * Works with the client-side navigation system to update specific parts of the page.
 *
 * @module
 */

import type { PropsWithChildren } from "hono/jsx";
import type { PartialContentElement } from "../client/wc-partialContent.ts";
import type { ActivatedClientFunction } from "../jsx-runtime.ts";

type PartialInsertHandler = ActivatedClientFunction<
  (this: PartialContentElement, element: PartialContentElement) => void
>;

/** Props for the Partial component */
export type PartialProps = {
  /** Unique identifier for this partial region */
  id: string;
  /** Runs when the incoming partial content is connected to the document. */
  onLoad: PartialInsertHandler;
  groupName?: string;
  mode?: never;
  [attribute: string]: unknown;
};

/**
 * Partial component for declaring partial page update regions.
 *
 * @example
 * ```tsx
 * <Partial id="user-profile" onMount={fn.partialReplace}>
 *   <UserProfile user={user} />
 * </Partial>
 * ```
 */
export function OldPartial(
  props: PropsWithChildren<PartialProps>,
) {
  const { id, onMount, groupName, children, ...attributes } = props;
  return (
    <partial-content
      id={id}
      name={id}
      onMount={onMount}
      group-name={groupName}
      {...attributes}
    >
      {children}
    </partial-content>
  );
}
