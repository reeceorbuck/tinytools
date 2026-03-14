const basePath = "/handlers";
globalThis.handlers = new Proxy({}, {
  get(target, prop, receiver) {
    if (prop in target) {
      return (...args) => {
        const [thisValue, ...rest] = args;
        return Reflect.get(target, prop, receiver).call(thisValue, ...rest);
      };
    }
    console.warn(
      `Handler function "${prop.toString()}" not found in handlers proxy, importing...`
    );
    const callFunctionName = prop.toString();
    const scriptContent = import(`${basePath}/${callFunctionName}.js`).then(({ default: scriptContent2 }) => {
      console.warn(`Handler function "${callFunctionName}" imported on use.`);
      globalThis.handlers[callFunctionName] = scriptContent2;
      return scriptContent2;
    });
    return async (...args) => {
      const scriptFunction = await scriptContent;
      const [thisValue, ...rest] = args;
      return scriptFunction.call(thisValue, ...rest);
    };
  }
});
