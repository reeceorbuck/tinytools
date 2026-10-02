// Characters that could end the declaration, open a comment or a function, or
// break out of the attribute. Values containing them are skipped.
const unsafeValue = /[;{}()[\]"'\<>\r\n]|\/\*/;

/**
 * Inline style declaring the URL's path segments as `--path-<index>` and its
 * query params as `--param-<key>`, the same properties `setVariablesFromUrl`
 * keeps updated on the client. Render it on the element with
 * `onCurrentEntryChange={fn.setVariablesFromUrl}`, typically `<body>`.
 *
 * Values are unquoted so style queries such as `style(--path-1: 42)` match
 * the values set on the client.
 */
export function urlStyleVariables(url: string | URL): string {
  const { pathname, searchParams } = new URL(url);
  const declarations = pathname.split("/").filter(Boolean).map((
    part,
    i,
  ) => [`--path-${i}`, part]);
  for (const key of new Set(searchParams.keys())) {
    declarations.push([`--param-${key}`, searchParams.get(key)!]);
  }
  return declarations
    .filter(([property, value]) =>
      /^--[\w-]+$/.test(property) && value && !unsafeValue.test(value)
    )
    .map(([property, value]) => `${property}: ${value};`)
    .join(" ");
}
