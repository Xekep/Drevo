import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve("public/models/human-3.3.6");
rmSync(resolve("public/models/face-api-1.7.15"), {
  recursive: true,
  force: true,
});
mkdirSync(directory, { recursive: true });
for (const model of [
  "blazeface",
  "facemesh",
  "faceres",
]) {
  for (const suffix of [".bin", ".json"])
    copyFileSync(
      resolve("node_modules/@vladmandic/human/models", model + suffix),
      resolve(directory, model + suffix),
    );
}
console.log("Модель поиска лиц подготовлена.");
