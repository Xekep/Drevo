import test from "node:test";
import assert from "node:assert/strict";
import { chroniclePhotos } from "../src/domain/family-chronicle.ts";
import type { ArchivePhoto } from "../src/domain/types.ts";

const photo = (
  id: string,
  date: Partial<ArchivePhoto> = {},
  ids = ["a"],
): ArchivePhoto => ({
  id,
  title: id,
  url: `/media/${id}.png`,
  tags: ids.map((personId) => ({
    id: `${id}-${personId}`,
    personId,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  })),
  ...date,
});
test("chronicle sorts shooting dates, partial dates and unknowns without using upload dates", () => {
  const input = [
    photo("unknown", { createdAt: "1800-01-01" }),
    photo("later", { year: "1980" }),
    photo("month", { takenAt: "1950-05" }),
    photo("day", { takenAt: "1950-05-02" }),
    photo("year", { year: "1950" }),
  ];
  assert.deepEqual(
    chroniclePhotos(input, ["a"]).map((p) => p.id),
    ["year", "month", "day", "later", "unknown"],
  );
  assert.equal(input[0].id, "unknown", "the archive order remains untouched");
});
test("chronicle includes only tagged visible people and deduplicates shared photos", () => {
  const shared = photo("shared", {}, ["a", "b"]);
  assert.deepEqual(
    chroniclePhotos(
      [shared, shared, photo("other", {}, ["c"]), photo("untagged", {}, [])],
      ["a", "b"],
    ).map((p) => p.id),
    ["shared"],
  );
  assert.deepEqual(chroniclePhotos([shared], []), []);
});
test("invalid and approximate dates stay undated; valid leap days remain chronological", () => {
  assert.deepEqual(
    chroniclePhotos(
      [
        photo("invalid", { takenAt: "1900-02-29" }),
        photo("approximate", { year: "около 1850" }),
        photo("valid", { takenAt: "1904-02-29" }),
        photo("month13", { takenAt: "1800-13-01" }),
      ],
      ["a"],
    ).map((p) => p.id),
    ["valid", "approximate", "invalid", "month13"],
  );
});
test("same-date photos have a stable order independent of pagination or input order", () => {
  const a = photo("a", { year: "1940" }),
    b = photo("b", { year: "1940" });
  assert.deepEqual(
    chroniclePhotos([b, a], ["a"]),
    chroniclePhotos([a, b], ["a"]),
  );
});
test("free-form shooting period falls back to its recorded year and local dates use shared normalization", () => {
  assert.deepEqual(
    chroniclePhotos(
      [
        photo("later", { year: "1970" }),
        photo("summer", { takenAt: "лето 1965", year: "1965" }),
        photo("local", { takenAt: "2.1.1965" }),
      ],
      ["a"],
    ).map((p) => p.id),
    ["summer", "local", "later"],
  );
});
