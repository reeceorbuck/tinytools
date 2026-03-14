/**
 * Partial Component for @tiny-tools/hono
 *
 * Provides a component for declaring partial page update regions.
 * Works with the client-side navigation system to update specific parts of the page.
 *
 * @module
 */

import type { PropsWithChildren } from "hono/jsx";

/** Available modes for partial updates */
export type PartialMode =
  | "replace"
  | "delete"
  | "blast"
  | "merge-content"
  | "attributes";

/** Replacer strategies for merge-content mode */
type Replacers =
  | "substitute"
  | "substitute(append)"
  | "substitute(prepend)"
  | "match"
  | "match(append)"
  | "match(prepend)"
  | "delete";

type BasicPartial = {
  mode: "replace" | "delete" | "blast";
};

type AttributesPartial = {
  mode: "attributes";
  [key: string]: string;
};

type ChildPartial = {
  mode: "merge-content";
  existing?: Replacers;
  new?: "append" | "prepend" | "ignore";
  groupName?: string;
  group?: Replacers;
};

type NonChildPartial = BasicPartial | AttributesPartial;

/** Props for the Partial component */
export type PartialProps = (NonChildPartial | ChildPartial) & {
  /** Unique identifier for this partial region */
  id: string;
};

/**
 * Partial component for declaring partial page update regions.
 *
 * Modes:
 * - `replace`: Replace the content of the existing element
 * - `delete`: Remove the existing element
 * - `blast`: Replace the existing element completely (removes wrapper)
 * - `merge-content`: Intelligently merge children with existing content
 * - `attributes`: Update attributes of the existing element
 *
 * @example
 * ```tsx
 * import { Partial } from "@tiny-tools/hono/components";
 *
 * // Simple replacement
 * <Partial id="user-profile" mode="replace">
 *   <UserProfile user={user} />
 * </Partial>
 *
 * // Merge content with existing
 * <Partial id="message-list" mode="merge-content" new="append">
 *   <Message message={newMessage} />
 * </Partial>
 *
 * // Update attributes only
 * <Partial id="submit-btn" mode="attributes" disabled="true" />
 * ```
 */
export function Partial(
  props: PropsWithChildren<PartialProps>,
) {
  if (props.mode === "attributes") {
    const { id, mode, ...attributes } = props;
    return (
      <partial
        id={id}
        name={id}
        mode={mode}
        {...attributes}
      />
    );
  }
  return (
    <partial
      id={props.id}
      name={props.id}
      mode={props.mode}
      existing={props.mode === "merge-content"
        ? props.existing || "substitute"
        : undefined}
      new={props.mode === "merge-content" ? props.new || "append" : undefined}
      group-name={props.mode === "merge-content" ? props.groupName : undefined}
      group={props.mode === "merge-content" ? props.group : undefined}
    >
      {props.children}
    </partial>
  );
}
