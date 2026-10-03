import { readFileSync } from "node:fs";

function readReleaseId() {
  try {
    const data = JSON.parse(
      readFileSync(new URL("../../release.json", import.meta.url), "utf8"),
    ) as { releaseId?: unknown };
    if (
      typeof data.releaseId !== "string" ||
      !/^[0-9a-f]{40}-[1-9][0-9]*$/.test(data.releaseId)
    )
      throw new Error("Некорректный идентификатор релиза");
    return data.releaseId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Read the immutable release directory, not the moving current symlink.
export const runtimeReleaseId = readReleaseId();
