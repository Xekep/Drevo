import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

test("archive search exposes a dedicated clear button on desktop and mobile", () => {
  const search = readFileSync(
    new URL("src/components/tree-search.tsx", root),
    "utf8",
  );
  const css = readFileSync(
    new URL("src/styles/mobile-refinements.css", root),
    "utf8",
  );

  assert.match(search, /query && \([\s\S]*archive-search-clear/);
  assert.match(search, /aria-label="Очистить поиск"/);
  assert.match(search, /onClick=\{clearQuery\}/);
  assert.match(search, /onQuery\(""\)[\s\S]*ref\.current\?\.focus\(\)/);
  assert.match(
    css,
    /\.archive-search-clear\s*\{[\s\S]*width: 30px;[\s\S]*height: 30px;/,
  );
  assert.match(
    css,
    /@media \(max-width: 899px\)[\s\S]*\.archive-search-clear\s*\{[\s\S]*width: 44px;[\s\S]*height: 44px;/,
  );
});
