import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openArchive } from "../src/server/database.ts";
import { removeStarterFamily } from "../src/server/demo-cleanup.ts";
import { settingsStore } from "../src/server/settings.ts";
import { userStore } from "../src/server/users.ts";
import {
  validateFamily,
  yearY,
  yearAtY,
  position,
  END_YEAR,
} from "../src/domain/index.ts";

test("starter cleanup preserves real people, photos, accounts and settings and runs once", () => {
  const family = validateFamily(
    JSON.parse(
      readFileSync(new URL("./fixtures/family.json", import.meta.url), "utf8"),
    ),
  );
  family.demo = false; // A prior settings edit must not hide the original sample.
  const preserved = {
    ...family.people[0],
    id: "real",
    birth: "1900",
    death: undefined,
    createdBy: "user",
    parents: [family.people[0].id],
    spouses: [],
    parentageComplete: true,
  };
  family.people.push(preserved);
  family.photos = [
    {
      id: "uploaded",
      url: "/media/uploaded.jpg",
      title: "Личное фото",
      createdBy: "user",
      tags: [
        {
          id: "real-tag",
          personId: "real",
          x: 0,
          y: 0,
          width: 0.2,
          height: 0.2,
        },
        {
          id: "demo-tag",
          personId: family.people[0].id,
          x: 0.4,
          y: 0.4,
          width: 0.2,
          height: 0.2,
        },
      ],
    },
  ];
  const archive = openArchive(":memory:", family);
  try {
    const settings = settingsStore(archive.db);
    settings.write({
      publicTree: false,
      publicAlbums: true,
      reverseTimeline: true,
    });
    const users = userStore(archive.db);
    users.register("user", "Владелец");
    removeStarterFamily(archive);
    const result = archive.read();
    assert.deepEqual(
      result.family.people.map((p) => p.id),
      ["real"],
    );
    assert.deepEqual(result.family.people[0].parents, []);
    assert.equal(result.family.people[0].parentageComplete, false);
    assert.equal(result.family.photos!.length, 1);
    assert.deepEqual(
      result.family.photos![0].tags.map((t) => t.id),
      ["real-tag"],
    );
    assert.equal(result.family.demo, false);
    assert.equal(users.get("user")!.role, "admin");
    assert.equal(settings.read().reverseTimeline, true);
    assert.equal(
      archive.db.prepare("SELECT count(*) AS n FROM history").get()!.n,
      1,
    );
    removeStarterFamily(archive);
    assert.equal(archive.read().revision, result.revision);
  } finally {
    archive.close();
  }
});

test("timeline reversal keeps epoch intervals positive, flips node order and preserves scrolling coordinates", () => {
  const family = validateFamily(
    JSON.parse(
      readFileSync(new URL("./fixtures/family.json", import.meta.url), "utf8"),
    ),
  );
  const people = [...family.people].sort((a, b) =>
    a.birth.localeCompare(b.birth),
  );
  for (const start of [1830, 1500]) {
    for (const reverse of [false, true]) {
      for (const year of [start, 1917, 1922, 1991, END_YEAR])
        assert.equal(
          yearAtY(yearY(year, start, reverse), start, reverse),
          year,
        );
      const y1 = position(people[0], start, reverse).y,
        y2 = position(people.at(-1)!, start, reverse).y;
      assert.equal(y1 < y2, !reverse);
      assert.ok(
        Math.min(yearY(1922, start, reverse), yearY(1991, start, reverse)) >=
          60,
      );
      assert.equal(
        Math.abs(yearY(1991, start, reverse) - yearY(1922, start, reverse)),
        69 * 8,
      );
    }
  }
});
