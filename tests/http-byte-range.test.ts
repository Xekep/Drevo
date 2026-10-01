import test from "node:test";
import assert from "node:assert/strict";
import { httpByteRange } from "../src/server/http-byte-range.ts";

test("single byte ranges include bounded, open-ended and suffix requests", () => {
  for (const [header, expected] of [
    ["bytes=0-9", { start: 0, end: 9 }],
    ["bytes=90-", { start: 90, end: 99 }],
    ["bytes=-10", { start: 90, end: 99 }],
    ["bytes=90-1000", { start: 90, end: 99 }],
    ["bytes=-1000", { start: 0, end: 99 }],
    ["bytes=99-99", { start: 99, end: 99 }],
  ] as const)
    assert.deepEqual(httpByteRange(header, 100), expected);
});

test("out-of-file ranges are unsatisfiable, malformed and multipart ranges are ignored", () => {
  for (const header of [
    "bytes=100-",
    "bytes=100-200",
    "bytes=-0",
    "bytes=99999999999999999999-",
  ])
    assert.equal(httpByteRange(header, 100), "unsatisfiable");
  assert.equal(httpByteRange("bytes=0-0", 0), "unsatisfiable");
  for (const header of [
    undefined,
    "bytes=-",
    "bytes=10-5",
    "bytes=0-9,20-29",
    "items=0-9",
    "bytes=1.5-2",
    "bytes=0-NaN",
  ])
    assert.equal(httpByteRange(header, 100), undefined);
});
