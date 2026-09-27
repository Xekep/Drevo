#!/usr/bin/env node
// Rebuild the checked-in catalogue thumbnails from their attributed Commons files.
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(readFileSync(join(root, "src/features/awards/catalog/image-sources.json"), "utf8"));
const force = process.argv.includes("--force");
const userAgent = "Drevo award asset builder/1.0 (https://mydrevo.org)";

async function getImageInfo(files) {
  const images = new Map();
  for (let offset = 0; offset < files.length; offset += 20) {
    const batch = files.slice(offset, offset + 20);
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.search = new URLSearchParams({
      action: "query", format: "json", titles: batch.map((file) => `File:${file}`).join("|"),
      prop: "imageinfo", iiprop: "url", iiurlwidth: "800",
    });
    const response = await fetch(api, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Commons metadata HTTP ${response.status}`);
    const data = await response.json();
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (info) images.set(page.title.replace(/^File:/, ""), info.thumburl ?? info.url);
    }
  }
  return images;
}

function removeCornerBackground(data, width, height, minimum = 185) {
  const size = width * height;
  const seen = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  const corners = [0, width - 1, (height - 1) * width, size - 1];
  for (const corner of corners) {
    const offset = corner * 4;
    const colors = [data[offset], data[offset + 1], data[offset + 2]];
    if (Math.min(...colors) < minimum || Math.max(...colors) - Math.min(...colors) > 35) continue;
    if (seen[corner]) continue;
    seen[corner] = 1;
    queue[tail++] = corner;
  }
  if (tail === 0) return;
  while (head < tail) {
    const pixel = queue[head++];
    const offset = pixel * 4;
    const candidates = [pixel - width, pixel + width];
    if (pixel % width > 0) candidates.push(pixel - 1);
    if (pixel % width < width - 1) candidates.push(pixel + 1);
    for (const next of candidates) {
      if (next < 0 || next >= size || seen[next]) continue;
      const pos = next * 4;
      const low = Math.min(data[pos], data[pos + 1], data[pos + 2]);
      const high = Math.max(data[pos], data[pos + 1], data[pos + 2]);
      if (low < minimum || high - low > 35) continue;
      seen[next] = 1;
      queue[tail++] = next;
    }
    data[offset + 3] = 0;
  }
}

async function prepare(buffer, source, destination) {
  let image = sharp(buffer, { limitInputPixels: 25_000_000 }).rotate();
  const metadata = await image.metadata();
  if (source.crop === "left-half") image = image.extract({ left: 0, top: 0, width: Math.floor(metadata.width / 2), height: metadata.height });
  if (source.crop?.startsWith("third-")) {
    const third = Math.floor(metadata.width / 3);
    const index = { left: 0, center: 1, right: 2 }[source.crop.slice(6)];
    if (index === undefined) throw new Error(`Invalid crop for ${source.id}`);
    image = image.extract({ left: index * third, top: 0, width: index === 2 ? metadata.width - 2 * third : third, height: metadata.height });
  }
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  removeCornerBackground(data, info.width, info.height, source.backgroundMin ?? 185);
  await sharp(data, { raw: info })
    .trim({ background: "#00000000", threshold: 10 })
    .resize(488, 488, { fit: "inside", withoutEnlargement: true })
    .extend({ top: 12, bottom: 12, left: 12, right: 12, background: "#00000000" })
    .png({ palette: true, quality: 90, effort: 8 })
    .toFile(destination);
}

const pending = sources.filter((source) => force || !existsSync(join(root, "public/awards", source.path)));
const info = await getImageInfo(pending.map((source) => source.commonsFile));
for (const source of pending) {
  const url = info.get(source.commonsFile);
  if (!url || !/^https:\/\/(?:thumb\.|upload\.)wikimedia\.org\//.test(url)) throw new Error(`Missing Commons image: ${source.commonsFile}`);
  let buffer;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      if (attempt === 4) throw new Error(`${source.commonsFile}: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
    }
  }
  const destination = join(root, "public/awards", source.path);
  mkdirSync(dirname(destination), { recursive: true });
  await prepare(buffer, source, destination);
  console.log(source.path);
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
console.log(`Prepared ${pending.length} catalogue award images.`);
