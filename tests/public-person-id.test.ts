import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePublicPersonId, publicPersonId } from "../src/server/public-person-id.ts";

test("published person IDs retain punctuation and Unicode through one URL decode", () => {
  for (const id of ["person-a", "family:person.1", "семья:человек.1", "person 1"]) {
    assert.equal(publicPersonId(id), true);
    assert.equal(decodePublicPersonId(encodeURIComponent(id)), id);
  }
});

test("published person routes reject separators, malformed escapes and a second decode", () => {
  for (const segment of ["a%2Fb", "a%5Cb", "a%00b", "a%252Fb", "a%255Cb",
    "a%2500b", "a%25b", "a%", "%E0%A4%A", ".", "..", "a".repeat(101)])
    assert.equal(decodePublicPersonId(segment), null, segment);
  for (const id of ["a/b", "a\\b", "a%b", "a\0b", ".", "..", "a".repeat(101)])
    assert.equal(publicPersonId(id), false, id);
});
