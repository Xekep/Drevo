import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { importFaceDescriptors } from "../src/server/face-descriptor-import.ts";
import type { Family } from "../src/domain/types.ts";

const family: Family = {
  title: "Образцы лиц",
  description: "",
  demo: false,
  people: [
    {
      id: "person",
      name: "Иван",
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birth: "",
      birthPlace: "",
      parents: [],
      spouses: [],
      sources: [],
      generation: 1,
      column: 0,
    },
  ],
  photos: [
    {
      id: "photo",
      url: "/media/photo.jpg",
      title: "",
      tags: [
        { id: "tag", personId: "person", x: 0, y: 0, width: 0.5, height: 0.5 },
      ],
    },
  ],
};

test("1024-D backfill imports beside legacy tokens and can be rerun", () => {
  const archive = openArchive(":memory:", family);
  try {
    const legacy = {
      id: "tag:photo:tag",
      personId: "person",
      descriptor: Array(128).fill(0.1),
    };
    assert.deepEqual(importFaceDescriptors(archive.db, [legacy]), {
      received: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
    });
    const human = {
      ...legacy,
      descriptor: Array(1024).fill(0.04),
      sourcePhotoId: "photo",
      sourceTagId: "tag",
      model: "human-faceres-3.3.6",
    };
    assert.deepEqual(importFaceDescriptors(archive.db, [human]), {
      received: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
    });
    const rows = archive.db
      .prepare(
        "SELECT id,model,source_photo_id,source_tag_id FROM face_descriptors ORDER BY model",
      )
      .all();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.model),
      ["face-api-1.7.15", "human-faceres-3.3.6"],
    );
    assert.match(String(rows[1].id), /^face-[a-f0-9]{32}$/);
    assert.equal(rows[1].source_photo_id, "photo");
    assert.equal(rows[1].source_tag_id, "photo:tag");
    assert.deepEqual(importFaceDescriptors(archive.db, [human]), {
      received: 1,
      inserted: 0,
      updated: 0,
      skipped: 1,
    });
    assert.deepEqual(
      importFaceDescriptors(archive.db, [
        { ...human, descriptor: Array(1024).fill(0.05) },
      ]),
      { received: 1, inserted: 0, updated: 1, skipped: 0 },
    );
    const updated = archive.db
      .prepare("SELECT data FROM face_descriptors WHERE model=?")
      .get("human-faceres-3.3.6");
    assert.equal(JSON.parse(String(updated!.data))[0], 0.05);
  } finally {
    archive.close();
  }
});

test("backfill rejects unconfirmed provenance and rolls back the batch", () => {
  const archive = openArchive(":memory:", family);
  try {
    const valid = {
      id: "valid",
      personId: "person",
      descriptor: Array(1024).fill(0.04),
      sourcePhotoId: "photo",
      model: "human-faceres-3.3.6",
    };
    assert.throws(
      () =>
        importFaceDescriptors(archive.db, [
          valid,
          { ...valid, id: "invalid", sourcePhotoId: "other" },
        ]),
      /Missing confirmed photo tag/,
    );
    assert.equal(
      archive.db.prepare("SELECT count(*) AS n FROM face_descriptors").get()!.n,
      0,
    );
    assert.throws(
      () =>
        importFaceDescriptors(archive.db, [{ ...valid, descriptor: [0.1] }]),
      /Invalid face descriptor input/,
    );
  } finally {
    archive.close();
  }
});
