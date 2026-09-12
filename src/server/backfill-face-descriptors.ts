import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import * as faceapi from "@vladmandic/face-api";
import { initializeArchiveSchema } from "./schema.ts";

type Tag = {
  id: string;
  personId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const [databasePath, uploadsPath, outputPath] = process.argv.slice(2);
if (!databasePath || !uploadsPath || !outputPath)
  throw new Error(
    "Usage: backfill-face-descriptors <database.sqlite> <uploads-dir> <descriptors.json>",
  );

function tagContains(
  tag: Tag,
  box: { x: number; y: number; width: number; height: number },
) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return (
    x >= tag.x &&
    x <= tag.x + tag.width &&
    y >= tag.y &&
    y <= tag.y + tag.height
  );
}

function imagePath(url: string) {
  const file = basename(url);
  return /^[-a-zA-Z0-9]+\.(jpg|png|webp|gif)$/.test(file)
    ? resolve(uploadsPath, file)
    : undefined;
}

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
try {
  const backupDirectory = join(dirname(databasePath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = join(
    backupDirectory,
    `before-face-descriptor-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
  );
  db.prepare("VACUUM INTO ?").run(backupPath);
  initializeArchiveSchema(db);

  const modelDirectory = resolve("node_modules/@vladmandic/face-api/model");
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDirectory),
    faceapi.nets.faceLandmark68Net.loadFromDisk(modelDirectory),
    faceapi.nets.faceRecognitionNet.loadFromDisk(modelDirectory),
  ]);

  const rows = db
    .prepare(
      `SELECT p.id AS photo_id,p.data AS photo_data,t.id AS tag_id,t.person_id,t.data AS tag_data
       FROM photos p JOIN photo_tags t ON t.photo_id=p.id ORDER BY p.rowid,t.rowid`,
    )
    .all() as Array<Record<string, unknown>>;
  const inserted = db.prepare(
    "INSERT OR IGNORE INTO face_descriptors(id,person_id,data) VALUES(?,?,?)",
  );
  let saved = 0;
  let missing = 0;
  let unmatched = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const photoId = String(row.photo_id);
    const tag = JSON.parse(String(row.tag_data)) as Tag;
    const id = `tag:${photoId}:${tag.id}`;
    if (db.prepare("SELECT 1 FROM face_descriptors WHERE id=?").get(id))
      continue;
    try {
      const photo = JSON.parse(String(row.photo_data)) as { url?: unknown };
      const path =
        typeof photo.url === "string" ? imagePath(photo.url) : undefined;
      if (!path || !existsSync(path)) {
        missing++;
        continue;
      }
      const decoded = await sharp(path)
        .rotate()
        .resize({
          width: 1800,
          height: 1800,
          fit: "inside",
          withoutEnlargement: true,
        })
        .toColourspace("srgb")
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const tensor = faceapi.tf.tensor3d(
        new Uint8Array(decoded.data),
        [decoded.info.height, decoded.info.width, decoded.info.channels],
        "int32",
      );
      try {
        const faces = await faceapi
          .detectAllFaces(
            tensor,
            new faceapi.SsdMobilenetv1Options({
              minConfidence: 0.55,
              maxResults: 100,
            }),
          )
          .withFaceLandmarks()
          .withFaceDescriptors();
        const match = faces.find((face) => {
          const box = face.detection.box;
          return tagContains(tag, {
            x: box.x / decoded.info.width,
            y: box.y / decoded.info.height,
            width: box.width / decoded.info.width,
            height: box.height / decoded.info.height,
          });
        });
        if (!match) {
          unmatched++;
          continue;
        }
        if (
          inserted.run(
            id,
            String(row.person_id),
            JSON.stringify(Array.from(match.descriptor)),
          ).changes
        )
          saved++;
      } finally {
        tensor.dispose();
      }
    } catch (error) {
      errors.push(
        `${photoId}/${tag.id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  const descriptors = db
    .prepare("SELECT id,person_id,data FROM face_descriptors ORDER BY rowid")
    .all()
    .map((row) => ({
      id: String(row.id),
      personId: String(row.person_id),
      descriptor: JSON.parse(String(row.data)),
    }));
  writeFileSync(outputPath, JSON.stringify(descriptors), { mode: 0o600 });
  console.log(
    JSON.stringify({
      backupPath,
      tagged: rows.length,
      saved,
      missing,
      unmatched,
      errors,
    }),
  );
} finally {
  db.close();
}
