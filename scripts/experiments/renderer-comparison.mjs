// Run after installing the isolated evaluation dependencies listed in stage17.md.
// SSR parse+serialize benchmark, NOT an estimate of browser streaming frame time.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const root = createRequire(new URL("../../package.json", import.meta.url));
const candidate = createRequire(
  new URL("../../work/streamdown-eval/package.json", import.meta.url),
);
const React = candidate("react"),
  { renderToStaticMarkup } = candidate("react-dom/server");
const { Streamdown, defaultRehypePlugins } = await import(
  new URL(
    "../../work/streamdown-eval/node_modules/streamdown/dist/index.js",
    import.meta.url,
  )
);
const { harden } = await import(candidate.resolve("rehype-harden"));
const t = root("@diplodoc/transform");
const transform = t.default ?? t;
const r = root("remend");
const remend = r.default ?? r;
const settings = {
  mode: "streaming",
  isAnimating: true,
  controls: false,
  skipHtml: true,
  rehypePlugins: [
    defaultRehypePlugins.sanitize,
    [
      harden,
      {
        defaultOrigin: "http://localhost:53129",
        allowedImagePrefixes: [],
        allowedLinkPrefixes: ["https://", "http://"],
        allowedProtocols: ["https", "http"],
        allowDataImages: false,
      },
    ],
  ],
};
const { JSDOM } = root("jsdom");
const renderers = {
  gravityPipeline: (text) =>
    renderToStaticMarkup(
      React.createElement("div", {
        dangerouslySetInnerHTML: {
          __html: transform(remend(text), { html: false }).result.html,
        },
      }),
    ),
  streamdown: (text) =>
    renderToStaticMarkup(React.createElement(Streamdown, settings, text)),
};
const cases = {
  plain: "Hello, **world**!",
  code: "```python\nprint(2+3)\n",
  table: "| A | B |\n|---|---|\n| 1 | 2 |",
  partial: "Text **incomplete",
  hostile:
    '<script>alert(1)</script>\n[click](javascript:alert(1))\n<img src=x onerror="alert(1)">',
};
const result = {
  versions: { gravity: "3.4.0", streamdown: "2.7.1" },
  method:
    "fresh SSR parse+serialize, 3 runs, 60 prefixes of ~7.7KB mixed Markdown; no component cache or browser layout",
  cases: {},
  bench: {},
};
for (const [name, render] of Object.entries(renderers)) {
  result.cases[name] = {};
  for (const [key, text] of Object.entries(cases)) {
    const html = render(text);
    result.cases[name][key] = {
      codeBlock: html.includes("<pre"),
      strong: html.includes("<strong"),
      table: html.includes("<table"),
      unsafe: (() => {
        const doc = new JSDOM(html).window.document;
        return Boolean(
          doc.querySelector("script,[onerror],[onload],a[href^='javascript:']"),
        );
      })(),
      html,
    };
  }
  const full = Array.from(
    { length: 60 },
    (_, i) =>
      `## Part ${i}\n\nExample response with **formatting** and a [link](https://example.test).\n\n\`\`\`python\nprint(${i})\n\`\`\`\n\n|A|B|\n|-|-|\n|1|2|\n\n`,
  ).join("");
  const times = [];
  render("warmup");
  for (let repeat = 0; repeat < 3; repeat++) {
    const start = performance.now();
    for (let i = 1; i <= 60; i++)
      render(full.slice(0, Math.ceil((full.length * i) / 60)));
    times.push(performance.now() - start);
  }
  result.bench[name] = {
    milliseconds: times,
    median: times.sort((a, b) => a - b)[1],
    inputLength: full.length,
  };
}
await writeFile(
  "work/stage17-renderer-results.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify(
    {
      bench: result.bench,
      safety: Object.fromEntries(
        Object.entries(result.cases).map(([k, c]) => [k, c.hostile.unsafe]),
      ),
    },
    null,
    2,
  ),
);
if (Object.values(result.cases).some((c) => c.hostile.unsafe))
  throw Error("Unsafe HTML rendered");
