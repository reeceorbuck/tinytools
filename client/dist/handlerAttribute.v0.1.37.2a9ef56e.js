function extractHandlerNames(attributeValue) {
  const names = Array.from(
    attributeValue.matchAll(/handlers\.(\w+)\.call\(this, event\)/g),
    (match) => match[1]
  );
  return names.length ? names : [attributeValue];
}
async function runHandlerAttribute(thisArg, event, attributeValue) {
  const handlers = globalThis.handlers;
  const handlerNames = extractHandlerNames(attributeValue);
  if (!attributeValue.startsWith("void (async()=>{")) {
    return await Promise.all(
      handlerNames.map(
        (handlerName) => handlers[handlerName].call(thisArg, event)
      )
    );
  }
  for (const handlerName of handlerNames) {
    const result = await handlers[handlerName].call(thisArg, event);
    if (result === false) return false;
  }
}
export {
  extractHandlerNames,
  runHandlerAttribute
};
