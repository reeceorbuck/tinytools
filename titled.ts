const contextTitles = new WeakMap<object, string>();

export function getContextTitle(context: object): string | undefined {
  return contextTitles.get(context);
}

/**
 * Wraps a route handler so its responses carry `title`: the renderer uses it
 * as the document title, and `handler.title` is readable for navigation.
 */
// deno-lint-ignore no-explicit-any
export function titled<T extends (...args: any[]) => any>(
  title: string,
  handler: T,
): T & { title: string } {
  const titledHandler = function (this: unknown, ...args: Parameters<T>) {
    const context = args[0];
    if (context && typeof context === "object") {
      contextTitles.set(context, title);
    }
    return handler.apply(this, args);
  } as T & { title: string };

  titledHandler.title = title;
  return titledHandler;
}
