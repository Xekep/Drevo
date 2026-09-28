import { createHash } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";

type FaceModel = "face-api-1.7.15" | "human-faceres-3.3.6";
type Descriptor = {
  id: string;
  personId: string;
  descriptor: number[];
  sourcePhotoId?: string;
  sourceTagId?: string;
  model: FaceModel;
};

function parseDescriptors(values: unknown): Descriptor[] {
  if (!Array.isArray(values))
    throw new Error("Expected an array of face descriptors");
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid face descriptor input");
    const sample = value as Record<string, unknown>;
    const model = sample.model ?? "face-api-1.7.15";
    const dimensions = model === "human-faceres-3.3.6" ? 1024 : 128;
    const maxValue = model === "human-faceres-3.3.6" ? 100 : 2;
    if (
      (model !== "human-faceres-3.3.6" && model !== "face-api-1.7.15") ||
      typeof sample.id !== "string" ||
      !sample.id ||
      sample.id.length > 250 ||
      typeof sample.personId !== "string" ||
      !sample.personId ||
      sample.personId.length > 200 ||
      !Array.isArray(sample.descriptor) ||
      sample.descriptor.length !== dimensions ||
      !sample.descriptor.every(
        (item) =>
          typeof item === "number" &&
          Number.isFinite(item) &&
          Math.abs(item) <= maxValue,
      ) ||
      (model === "human-faceres-3.3.6" &&
        (typeof sample.sourcePhotoId !== "string" ||
          !sample.sourcePhotoId ||
          sample.sourcePhotoId.length > 200)) ||
      (sample.sourceTagId !== undefined &&
        (typeof sample.sourceTagId !== "string" ||
          !sample.sourceTagId ||
          sample.sourceTagId.length > 200))
    )
      throw new Error("Invalid face descriptor input");
    return {
      id: sample.id,
      personId: sample.personId,
      descriptor: sample.descriptor,
      sourcePhotoId:
        typeof sample.sourcePhotoId === "string"
          ? sample.sourcePhotoId
          : undefined,
      sourceTagId:
        typeof sample.sourceTagId === "string" ? sample.sourceTagId : undefined,
      model,
    };
  });
}

export async function importFaceDescriptors(
  db: StoreDatabase,
  values: unknown,
) {
  const descriptors = parseDescriptors(values);
  const person = db.prepare(
    "SELECT 1 FROM people WHERE id=?",
    "SELECT 1 FROM people WHERE id=?",
  );
  const tagged = db.prepare(
    `SELECT id
       FROM photo_tags
      WHERE photo_id=?
        AND person_id=?
        AND (? IS NULL OR id=?)
      ORDER BY rowid
      LIMIT 1`,
    "SELECT id\n       FROM photo_tags\n      WHERE photo_id=?\n        AND person_id=?\n        AND (? IS NULL OR id=?)\n      ORDER BY ordinal\n      LIMIT 1",
  );
  const existing = db.prepare(
    "SELECT person_id,data,source_photo_id,source_tag_id,model FROM face_descriptors WHERE id=?",
    "SELECT person_id,data,source_photo_id,source_tag_id,model FROM face_descriptors WHERE id=?",
  );
  const insert = db.prepare(
    `INSERT INTO face_descriptors
       (id,person_id,data,source_photo_id,source_tag_id,model)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       person_id=excluded.person_id,
       data=excluded.data,
       source_photo_id=excluded.source_photo_id,
       source_tag_id=excluded.source_tag_id,
       model=excluded.model`,
    "INSERT INTO face_descriptors\n       (id,person_id,data,source_photo_id,source_tag_id,model)\n     VALUES(?,?,?,?,?,?)\n     ON CONFLICT(archive_id,id) DO UPDATE SET\n       person_id=excluded.person_id,\n       data=excluded.data,\n       source_photo_id=excluded.source_photo_id,\n       source_tag_id=excluded.source_tag_id,\n       model=excluded.model",
  );
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  await db.transaction(async () => {
    for (const sample of descriptors) {
      if (!(await person.get(sample.personId)))
        throw new Error(`Unknown person: ${sample.personId}`);
      const requestedTagRowId =
        sample.model === "human-faceres-3.3.6" && sample.sourceTagId
          ? `${sample.sourcePhotoId}:${sample.sourceTagId}`
          : null;
      const confirmedTag =
        sample.model === "human-faceres-3.3.6"
          ? await tagged.get(
              sample.sourcePhotoId || "",
              sample.personId,
              requestedTagRowId,
              requestedTagRowId,
            )
          : undefined;
      if (sample.model === "human-faceres-3.3.6" && !confirmedTag)
        throw new Error(
          `Missing confirmed photo tag: ${sample.sourcePhotoId} / ${sample.personId}`,
        );
      const sourceTagRowId =
        sample.model === "human-faceres-3.3.6"
          ? String(confirmedTag!.id)
          : null;
      // A legacy sample may have used the same tag ID. Model-scoped IDs keep
      // both generations without silently discarding the new 1024-D sample.
      const id =
        sample.model === "human-faceres-3.3.6"
          ? `face-${createHash("sha256")
              .update(`${sample.model}\0${sample.id}`)
              .digest("hex")
              .slice(0, 32)}`
          : sample.id;
      const data = JSON.stringify(sample.descriptor);
      const previous = await existing.get(id);
      if (previous && sample.model === "face-api-1.7.15") {
        skipped++;
        continue;
      }
      if (
        previous &&
        previous.person_id === sample.personId &&
        previous.data === data &&
        previous.source_photo_id === (sample.sourcePhotoId || null) &&
        previous.source_tag_id === sourceTagRowId &&
        previous.model === sample.model
      ) {
        skipped++;
        continue;
      }
      if (previous && previous.model !== sample.model)
        throw new Error(`Descriptor ID collision: ${id}`);
      await insert.run(
        id,
        sample.personId,
        data,
        sample.sourcePhotoId || null,
        sourceTagRowId,
        sample.model,
      );
      if (previous) updated++;
      else inserted++;
    }
  });
  return { received: descriptors.length, inserted, updated, skipped };
}
