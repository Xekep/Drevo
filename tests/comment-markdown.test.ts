import test from "node:test";
import assert from "node:assert/strict";
import { renderCommentHtml } from "../src/components/discussion/markdown-format.ts";

test("comment Markdown renders lists, links, code and both kinds of LaTeX", () => {
  const html = renderCommentHtml(
    "## Источник\n\n**Проверено** и *уточнение*. $x^2$\n\n- [Архив](https://example.com)\n- `код $x$`\n\n$$\n\\frac{1}{2}\n$$",
  );
  assert.match(html, /<h2>Источник<\/h2>/);
  assert.match(html, /<strong>Проверено<\/strong>/);
  assert.match(html, /<em>уточнение<\/em>/);
  assert.match(html, /<ul>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<code>код \$x\$<\/code>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
});

test("comment HTML and formula commands cannot inject script or active URLs", () => {
  const html = renderCommentHtml(
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[ссылка](javascript:alert%281%29)\n\n![фото](javascript:alert%281%29)\n\n$\\href{javascript:alert(1)}{x}$",
  );
  assert.doesNotMatch(
    html,
    /<script|onerror=|href="javascript:|src="javascript:/i,
  );
  assert.match(html, /ссылка/);
});

test("invalid LaTeX remains readable without breaking the comment", () => {
  assert.match(renderCommentHtml("$\\notACommand{x}$"), /notACommand/);
  assert.match(renderCommentHtml("    код\n    ещё код"), /<pre><code>/);
});

test("outbound discussion links open separately while archive links stay local", () => {
  const html = renderCommentHtml(
    "[Архив](https://example.com/archive) http://example.org [Без схемы](//example.net) [Карточка](/people/person) [Раздел](#source) [Почта](mailto:archive@example.com)",
  );
  for (const href of ["https://example.com/archive", "http://example.org", "//example.net"]) {
    const anchor = html.match(/<a\b[^>]*>/g)!.find(tag => tag.includes(`href="${href}"`))!;
    assert.ok(anchor, href);
    assert.match(anchor, /target="_blank"/);
    assert.match(anchor, /rel="nofollow noopener noreferrer"/);
  }
  for (const href of ["/people/person", "#source", "mailto:archive@example.com"]) {
    const anchor = html.match(/<a\b[^>]*>/g)!.find(tag => tag.includes(`href="${href}"`))!;
    assert.ok(anchor, href);
    assert.doesNotMatch(anchor, /target=|rel=/);
  }
});
test("only Mermaid fenced code receives a diagram marker and raw SVG stays inactive", () => {
  const html = renderCommentHtml("```mermaid\ngraph TD\nA --> B\n```\n\n```javascript\nalert(1)\n```\n\n<svg onload=alert(1)></svg>");
  assert.match(html, /class="language-mermaid"/);
  assert.equal((html.match(/language-mermaid/g) || []).length, 1);
  assert.doesNotMatch(html, /<svg|onload=/);
});
