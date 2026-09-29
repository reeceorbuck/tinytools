const p = "handlerNamespace.ts";
let s = await Deno.readTextFile(p);
function rep(a: string, b: string) {
  if (s.split(a).length !== 2) throw new Error("missing: " + a.slice(0, 80));
  s = s.replace(a, () => b);
}
rep(`        : \`const \${binding} = \${handlerExpression(source)};\`;
    }),
    renamed.length`, `        : \`const \${binding} = \${handlerExpression(source)};\`;
    }),
  ].filter(Boolean);
  // Generated export lines are emitted verbatim after the transformed pieces.
  const exportLines = [
    renamed.length`);
rep(`  const body = [storedLine, ...pieces].join("\n");`, `  const body = [storedLine, ...pieces, ...exportLines].join("\n");`);
rep(`    ...transformed,
  ].filter(Boolean)`, `    ...transformed,
    ...exportLines,
  ].filter(Boolean)`);
await Deno.writeTextFile(p, s);
