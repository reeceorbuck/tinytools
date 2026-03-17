const basePath = "/handlers";
globalThis.handlers = new Proxy({}, {
  get(target, prop, receiver) {
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    if (typeof prop === "symbol") {
      return void 0;
    }
    const callFunctionName = prop.toString();
    console.warn(
      `Handler function "${callFunctionName}" not found in handlers proxy, importing...`
    );
    const scriptContent = import(`${basePath}/${callFunctionName}.js`).then(({ default: scriptContent2 }) => {
      console.warn(`Handler function "${callFunctionName}" imported on use.`);
      globalThis.handlers[callFunctionName] = scriptContent2;
      return scriptContent2;
    });
    return async function(...args) {
      const scriptFunction = await scriptContent;
      return scriptFunction.call(this, ...args);
    };
  }
});
