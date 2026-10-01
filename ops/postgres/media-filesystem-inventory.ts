import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ManifestRow =
  | { kind: "archive"; archive_id: string }
  | {
      kind: "ref";
      archive_id: string;
      name: string;
      source: string;
      known_bytes: number | null;
    };

const archivePattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/;
const filePattern = /^[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|pdf)$/;
const sources = new Set([
  "person", "photo", "history", "upload_grant", "image_metadata", "document",
]);

function parseManifest(input: string, legacyArchiveId: string) {
  const archives = new Set<string>();
  const refs = new Map<string, Map<string, { sources: Set<string>; knownBytes: number | null }>>();
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: ManifestRow;
    try {
      row = JSON.parse(line) as ManifestRow;
    } catch {
      throw new Error(`Invalid JSON on manifest line ${index + 1}`);
    }
    if (!row || typeof row.archive_id !== "string" || !archivePattern.test(row.archive_id))
      throw new Error(`Invalid archive ID on manifest line ${index + 1}`);
    if (row.kind === "archive") {
      archives.add(row.archive_id);
      continue;
    }
    if (row.kind !== "ref" || typeof row.name !== "string" ||
      typeof row.source !== "string" || !filePattern.test(row.name) || !sources.has(row.source))
      throw new Error(`Invalid media reference on manifest line ${index + 1}`);
    if (row.known_bytes !== null &&
      (!Number.isSafeInteger(row.known_bytes) || row.known_bytes <= 0))
      throw new Error(`Invalid media size on manifest line ${index + 1}`);
    const byName = refs.get(row.archive_id) || new Map();
    const previous = byName.get(row.name) || { sources: new Set<string>(), knownBytes: null };
    if (row.known_bytes !== null) {
      if (previous.knownBytes !== null && previous.knownBytes !== row.known_bytes)
        throw new Error(`Conflicting sizes for ${row.archive_id}/${row.name}`);
      previous.knownBytes = row.known_bytes;
    }
    previous.sources.add(row.source);
    byName.set(row.name, previous);
    refs.set(row.archive_id, byName);
  }
  if (!archives.has(legacyArchiveId)) throw new Error("Legacy archive missing from manifest");
  for (const archiveId of refs.keys())
    if (!archives.has(archiveId)) throw new Error(`Unknown archive in references: ${archiveId}`);
  return { archives, refs };
}

async function checkedDirectory(path: string, optional: boolean) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Not a regular directory: ${path}`);
  return true;
}

export async function inventoryMediaFiles(
  sharedRoot: string,
  legacyArchiveId: string,
  manifest: string,
) {
  if (!archivePattern.test(legacyArchiveId)) throw new Error("Invalid legacy archive ID");
  const root = resolve(sharedRoot);
  await checkedDirectory(root, false);
  const { archives, refs } = parseManifest(manifest, legacyArchiveId);
  const archivesDirectory = join(root, "archives");
  await checkedDirectory(archivesDirectory, true);
  const results = [];
  for (const archiveId of [...archives].sort()) {
    if (archiveId !== legacyArchiveId)
      await checkedDirectory(join(root, "archives", archiveId), true);
    const directory = archiveId === legacyArchiveId
      ? join(root, "uploads")
      : join(root, "archives", archiveId, "uploads");
    const expected = refs.get(archiveId) || new Map();
    const present = new Set<string>();
    const missing = [];
    const untracked = [];
    const sizeMismatches = [];
    const irregular = [];
    let files = 0;
    let bytes = 0;
    if (await checkedDirectory(directory, true)) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const info = await lstat(join(directory, entry.name));
        if (!entry.isFile() || !info.isFile() || !filePattern.test(entry.name)) {
          // AI attachments, previews and temporary uploads are not originals.
          // Symlinks and unexpected root entries still deserve review.
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.name.startsWith(".")))
            irregular.push(entry.name);
          continue;
        }
        files++;
        bytes += info.size;
        present.add(entry.name);
        const ref = expected.get(entry.name);
        if (!ref) untracked.push(entry.name);
        else if (ref.knownBytes !== null && ref.knownBytes !== info.size)
          sizeMismatches.push(entry.name);
      }
    }
    for (const name of expected.keys()) if (!present.has(name)) missing.push(name);
    results.push({
      archiveId, directory, files, bytes, references: expected.size,
      missing, untracked, sizeMismatches, irregular,
    });
  }
  const unknownArchiveDirectories = [];
  if (await checkedDirectory(archivesDirectory, true))
    for (const entry of await readdir(archivesDirectory, { withFileTypes: true }))
      if (!archives.has(entry.name)) unknownArchiveDirectories.push(entry.name);
  return { results, unknownArchiveDirectories };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sharedRoot, legacyArchiveId, manifestPath] = process.argv.slice(2);
  if (!sharedRoot || !legacyArchiveId || !manifestPath)
    throw new Error("Usage: media-filesystem-inventory.ts <shared-root> <legacy-archive-id> <manifest.jsonl>");
  const inventory = await inventoryMediaFiles(
    sharedRoot, legacyArchiveId, await readFile(manifestPath, "utf8"),
  );
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}
