import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeResearchMath } from "../src/domain/research-math.ts";

test("converts TeX delimiters outside Markdown code", () => {
  const input = [
    "Текст \\(x^2 + y^2\\) и `$не формула$`.",
    "",
    "\\[",
    "\\frac{1}{2} + z",
    "\\]",
    "",
    "```mermaid",
    "A[\\(подпись\\)] --> B",
    "```",
    "```latex",
    "x^2+y^2=z^2",
    "```",
    "    \\(код\\)",
  ].join("\n");
  const result = normalizeResearchMath(input);
  assert.match(result, /Текст \$x\^2 \+ y\^2\$/);
  assert.match(result, /\n\n\$\$\n\\frac\{1\}\{2\} \+ z\n\$\$\n\n/);
  assert.match(result, /`\$не формула\$`/);
  assert.match(result, /```mermaid\nA\[\\\(подпись\\\)\] --> B\n```/);
  assert.match(result, /```math\nx\^2\+y\^2=z\^2\n```/);
  assert.match(result, / {4}\\\(код\\\)/);
});

test("renders inline and display LaTeX alongside Markdown", () => {
  const source = normalizeResearchMath(
    "**Формула**: \\(E=mc^2\\).\n\n\\[\\frac{a}{b}=c\\]\n\n```latex\nx^2=y^2\n```",
  );
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [[rehypeKatex, { trust: false }]],
      },
      source,
    ),
  );
  assert.match(html, /<strong>Формула<\/strong>/);
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /\\\[/);
});

test("keeps unmatched TeX delimiters as text", () => {
  assert.equal(
    normalizeResearchMath("Скобка \\( без конца"),
    "Скобка \\( без конца",
  );
});
