/**
 * Event Handlers client script for @tiny-tools/hono
 *
 * Provides a global handlers proxy that lazily loads handler modules
 * when they are first called.
 */

/// <reference lib="dom" />

export type HandlerProxy = {
  // deno-lint-ignore no-explicit-any
  [key: string]: (...args: any[]) => void | Promise<void>;
};

declare global {
  var handlers: HandlerProxy;
  var navigation: Navigation;
}

const basePath = "/handlers";

globalThis.handlers = new Proxy<HandlerProxy>({} as HandlerProxy, {
  get(target, prop, receiver) {
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    if (typeof prop === "symbol") {
      return undefined;
    }
    const callFunctionName = prop.toString();
    console.warn(
      `Handler function "${callFunctionName}" not found in handlers proxy, importing...`,
    );
    const scriptContent = import(
      `${basePath}/${callFunctionName}.js`
    ).then(({ default: scriptContent }) => {
      console.warn(`Handler function "${callFunctionName}" imported on use.`);
      (globalThis.handlers as HandlerProxy)[callFunctionName] = scriptContent;
      return scriptContent;
    });

    // deno-lint-ignore no-explicit-any
    return async function (this: any, ...args: any[]) {
      const scriptFunction = await scriptContent;
      return scriptFunction.call(this, ...args);
    };
  },
});
