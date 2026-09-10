import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

test("archive search exposes a dedicated clear button on desktop and mobile", () => {
  const navigation = readFileSync(
    new URL("src/components/archive-navigation.tsx", root),
    "utf8",
  );
  const css = readFileSync(
    new URL("src/styles/mobile-refinements.css", root),
    "utf8",
  );

  assert.match(navigation, /query && \([\s\S]*archive-search-clear/);
  assert.match(navigation, /aria-label="Очистить поиск"/);
  assert.match(navigation, /onClick=\{clearQuery\}/);
  assert.match(navigation, /onQuery\(""\)[\s\S]*ref\.current\?\.focus\(\)/);
  assert.match(css, /\.archive-search-clear\s*\{[\s\S]*width: 30px;[\s\S]*height: 30px;/);
  assert.match(
    css,
    /@media \(max-width: 899px\)[\s\S]*\.archive-search-clear\s*\{[\s\S]*width: 38px;[\s\S]*height: 38px;/,
  );
});
