import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";
import { tiny } from "../mod.ts";

const handlers = new tiny.Handlers(import.meta.url, {
  referOnLoad: function (this: HTMLElement, e: Event) {
    console.log("referOnLoad", e);
    const target = this.previousSibling;
    if (target instanceof Element) {
      target.dispatchEvent(new Event("load"));
    }
    this.remove();
  },
});

export async function ActivateOnLoadHandler(
  { children }: PropsWithChildren,
): Promise<HtmlEscapedString> {
  const { fn } = await tiny.imports(handlers);
  const childElements = Array.isArray(children) ? children.flat() : [children];

  return (
    <>
      {childElements.map((child) => (
        <>
          {child}
          <img
            hidden
            src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
            onLoad={fn.referOnLoad}
          />
        </>
      ))}
    </>
  );
}
