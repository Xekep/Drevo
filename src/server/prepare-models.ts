import { mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve("public/models");
mkdirSync(directory, { recursive: true });
for (const model of [
  "ssd_mobilenetv1_model",
  "face_landmark_68_model",
  "face_recognition_model",
]) {
  for (const suffix of [".bin", "-weights_manifest.json"])
    copyFileSync(
      resolve("node_modules/@vladmandic/face-api/model", model + suffix),
      resolve(directory, model + suffix),
    );
}
console.log("Модель поиска лиц подготовлена.");
