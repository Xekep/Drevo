import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const manifest = new URL("../node_modules/picomatch/package.json", import.meta.url);
const parser = new URL("./lib/parse.js", manifest);
const stockHash = "4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4";
const patchedHash = "9bd315f0306e4c0caeb271b0419bb72605b03cd013c1793b1c9941b62d4736db";
const hash = (source) => createHash("sha256").update(source).digest("hex");

export function hasPatchedPicomatch() {
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version === "4.0.7" &&
      hash(readFileSync(parser)) === patchedHash;
  } catch {
    return false;
  }
}

function patchPicomatch() {
  let version;
  try {
    version = JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch (error) {
    if (error.code === "ENOENT") return; // npm ci --omit=dev
    throw error;
  }
  if (version !== "4.0.7") return;
  let source = readFileSync(parser, "utf8");
  if (hash(source) === patchedHash) return;
  if (hash(source) !== stockHash) throw new Error("Unexpected picomatch 4.0.7 parser");

  // Upstream PR micromatch/picomatch#237, head 1bf0d04563cb9ce568cf36efc5f6b7187d9911d5.
  const patch = readFileSync(new URL("./patches/picomatch-4.0.7.patch", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n").trimEnd();
  for (const [, body] of patch.matchAll(/^@@[^\n]*\n([\s\S]*?)(?=^@@|(?![\s\S]))/gm)) {
    const lines = body.trimEnd().split("\n");
    const before = lines.filter(line => !line.startsWith("+")).map(line => line.slice(1)).join("\n");
    const after = lines.filter(line => !line.startsWith("-")).map(line => line.slice(1)).join("\n");
    if (source.split(before).length !== 2) throw new Error("Unexpected picomatch patch context");
    source = source.replace(before, () => after);
  }
  if (hash(source) !== patchedHash) throw new Error("Unexpected patched picomatch checksum");
  writeFileSync(parser, source);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  patchPicomatch();
