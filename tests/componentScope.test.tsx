import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Child } from "hono/jsx";
import { type JSX, jsx, jsxAttr, jsxTemplate } from "../jsx-runtime.ts";
import { Styles } from "../clientTools.ts";
import { component, transparent } from "../componentScope.ts";
import { css, setCustomScope } from "../scopedStyles.ts";

const render = async (node: unknown) => String(await (await node)!.toString());

function Card({ children }: { children?: Child }) {
  return <section class="card">{children}</section>;
}

async function AsyncCard({ children }: { children?: Child }) {
  await Promise.resolve();
  return <section class="card">{children}</section>;
}

function PassThrough({ children }: { children?: Child }) {
  return children as JSX.Element;
}

function Pair() {
  return (
    <>
      <h2>one</h2>
      <p>two</p>
    </>
  );
}

function FormRoot() {
  return <form method="post"></form>;
}

function Outer() {
  return <Card />;
}

const Wrapper = transparent(function Wrapper(
  { children }: { children?: Child },
) {
  return <div class="wrapper">{children}</div>;
});

Deno.test("component scope - marks the root element with the component name", async () => {
  assertEquals(
    await render(<Card />),
    '<section class="card" data-tc="Card"></section>',
  );
});

Deno.test("component scope - marks async component roots", async () => {
  assertEquals(
    await render(
      <div>
        <AsyncCard />
      </div>,
    ),
    '<div><section class="card" data-tc="AsyncCard"></section></div>',
  );
});

Deno.test("component scope - leaves caller-owned children unmarked", async () => {
  assertEquals(
    await render(
      <Card>
        <p>slot</p>
      </Card>,
    ),
    '<section class="card" data-tc="Card"><p>slot</p></section>',
  );
  assertEquals(
    await render(
      <PassThrough>
        <p>mine</p>
      </PassThrough>,
    ),
    "<p>mine</p>",
  );
});

Deno.test("component scope - marks each root of a fragment", async () => {
  assertEquals(
    await render(<Pair />),
    '<h2 data-tc="Pair">one</h2><p data-tc="Pair">two</p>',
  );
});

Deno.test("component scope - marks intrinsic function tags such as form", async () => {
  assertStringIncludes(await render(<FormRoot />), 'data-tc="FormRoot"');
});

Deno.test("component scope - nested component root is marked once, by the innermost", async () => {
  assertEquals(
    await render(<Outer />),
    '<section class="card" data-tc="Card"></section>',
  );
});

Deno.test("component scope - transparent components are not marked", async () => {
  assertEquals(
    await render(<Wrapper>x</Wrapper>),
    '<div class="wrapper">x</div>',
  );
});

Deno.test("component scope - tiny.component marks directly-called output", async () => {
  const direct = () => component(<main>hi</main>, "Shell");
  assertEquals(await render(await direct()), '<main data-tc="Shell">hi</main>');
});

Deno.test("component scope - toComponent styles end at component roots, not .sb", () => {
  const tools = new Styles("file:///tests/component-scope.ts", {
    panel: setCustomScope.toComponent(css`
      color: red;
      p {
        color: blue;
      }
    `),
  });
  const content = tools._styles.get("panel")?.buildCssContent() ?? "";
  assertStringIncludes(content, "@layer normal");
  assertStringIncludes(content, "to ([data-tc], [data-scope-boundary~=");
  assertEquals(content.includes(".sb"), false);
});

// `"jsx": "precompile"` emits jsxTemplate calls for plain elements.
const tpl = (strings: string[], ...values: unknown[]) =>
  jsxTemplate(strings as unknown as TemplateStringsArray, ...values);

Deno.test("component scope - precompiled templates mark top-level tags only", async () => {
  const items = [tpl(["<li>a</li>"]), tpl(["<li>b</li>"])];
  const PrecompiledPair = () =>
    tpl(
      ['<h2 title="', '">one</h2><ul>', "</ul><p>two</p>"],
      "a>b",
      items,
    );
  assertEquals(
    await render(jsx(PrecompiledPair, {})),
    '<h2 data-tc="PrecompiledPair" title="a&gt;b">one</h2><ul data-tc="PrecompiledPair"><li>a</li><li>b</li></ul><p data-tc="PrecompiledPair">two</p>',
  );
});

Deno.test("component scope - precompiled templates handle attributes, slots and async", async () => {
  const PrecompiledCard = ({ children }: { children?: Child }) =>
    tpl(
      ["<section ", '><br><input value="1">', "</section>"],
      jsxAttr("class", "card"),
      children,
    );
  const SlowCard = async () => {
    await Promise.resolve();
    return tpl(["<aside>", "</aside>"], jsx(PrecompiledCard, {}));
  };
  assertEquals(
    await render(
      tpl(
        ["<main>", "", "</main>"],
        jsx(PrecompiledCard, { children: tpl(["<p>slot</p>"]) }),
        jsx(SlowCard, {}),
      ),
    ),
    '<main><section data-tc="PrecompiledCard" class="card"><br><input value="1"><p>slot</p></section>' +
      '<aside data-tc="SlowCard"><section data-tc="PrecompiledCard" class="card"><br><input value="1"></section></aside></main>',
  );
});

Deno.test("component scope - unmarked precompiled templates contain no sentinels", () => {
  const html = String(
    tpl(["<div ", ">x</div><span></span>"], jsxAttr("id", "a")),
  );
  assertEquals(html, '<div id="a">x</div><span></span>');
});
