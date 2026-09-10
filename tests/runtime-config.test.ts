import test from "node:test";
import assert from "node:assert/strict";
import { assertProductionOrigin } from "../src/server/runtime-config.ts";

test("production cannot silently become a local admin archive through missing or malformed origin", () => {
  for (const value of [
    undefined,
    "",
    "http://drevo.kiiko.ru",
    "https://drevo.kiiko.ru/",
    "https://drevo.kiiko.ru/path",
    "https://user:password@drevo.kiiko.ru",
    "https://drevo.kiiko.ru?x=1",
  ])
    assert.throws(() => assertProductionOrigin(true, value), /PUBLIC_ORIGIN/);
  assert.doesNotThrow(() =>
    assertProductionOrigin(true, "https://drevo.kiiko.ru"),
  );
  assert.doesNotThrow(() => assertProductionOrigin(false));
});
