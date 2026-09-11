import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const componentUrl = new URL("../src/components/memorial-name.tsx", import.meta.url);
const stylesUrl = new URL("../src/styles/family-details.css", import.meta.url);

test("голубь блокирует полёт только при явном reduced motion", async () => {
  const [component, styles] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(component, /prefers-reduced-motion: reduce/u);
  assert.doesNotMatch(component, /prefers-reduced-motion: no-preference/u);
  assert.match(styles, /\.dove-departed \.memorial-dove\s*\{[\s\S]*?animation:\s*dove-leave/u);
  assert.doesNotMatch(styles, /@media \(prefers-reduced-motion: no-preference\)/u);
});
