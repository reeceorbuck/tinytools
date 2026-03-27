// deno-lint-ignore no-explicit-any
export function titled<T extends (...args: any[]) => any>(
  title: string,
  handler: T,
): T & { title: string } {
  (handler as T & { title: string }).title = title;
  return handler as T & { title: string };
}
