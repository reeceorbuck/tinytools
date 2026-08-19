import type { GlobalPlusHandlers } from "./eventHandlers.ts";

/** Extracts handler filenames from a plain name or serialized JSX expression. */
export function extractHandlerNames(attributeValue: string): string[] {
  const names = Array.from(
    attributeValue.matchAll(/handlers\.(\w+)\.call\(this, event\)/g),
    (match) => match[1],
  );
  return names.length ? names : [attributeValue];
}

export async function runHandlerAttribute(
  thisArg: unknown,
  event: unknown,
  attributeValue: string,
): Promise<unknown> {
  const handlers = (globalThis as GlobalPlusHandlers).handlers;
  const handlerNames = extractHandlerNames(attributeValue);

  if (!attributeValue.startsWith("void (async()=>{")) {
    return await Promise.all(
      handlerNames.map((handlerName) =>
        handlers[handlerName].call(thisArg, event)
      ),
    );
  }

  for (const handlerName of handlerNames) {
    const result = await handlers[handlerName].call(thisArg, event);
    if (result === false) return false;
  }
}
