import { randomUUID } from "node:crypto";
import type { GeneratedResearchFile } from "./code-interpreter.ts";

const MAX_GENERATED_FILES_BYTES = 64 * 1024 * 1024;

export function pruneGeneratedResearchFiles(
  files: Map<string, GeneratedResearchFile>,
  now = Date.now(),
) {
  for (const [id, current] of files)
    if (current.expires <= now) files.delete(id);
}

/** All generated files share one bounded, process-local download cache. */
export function storeGeneratedResearchFile(
  files: Map<string, GeneratedResearchFile>,
  file: GeneratedResearchFile,
  now = Date.now(),
  maxBytes = MAX_GENERATED_FILES_BYTES,
) {
  pruneGeneratedResearchFiles(files, now);
  let used = 0;
  for (const current of files.values()) used += current.bytes.length;
  if (used + file.bytes.length > maxBytes) return null;
  const id = randomUUID();
  files.set(id, file);
  return id;
}
