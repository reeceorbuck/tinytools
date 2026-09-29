import { Handlers, imports } from "../clientTools.ts";
import { navigationTools } from "./navigationTools.ts";
import { sseTools } from "./sseTools.ts";

export const combineTools = new Handlers(import.meta.url, async () => {
  const { fn } = await imports(navigationTools, sseTools);
  return {
    combineCoreHandlers: function (this: HTMLElement, event: Event) {
      console.log("combineCoreHandlers triggered, event: ", event);
      fn.handleNavigate.apply(this);
      fn.setPathVariables.apply(this);
      fn.activateSSE.call(this, event);
    },
  };
});
