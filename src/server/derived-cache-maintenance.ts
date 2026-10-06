import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const DAY = 86_400_000;
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const generatedPreview = new RegExp(
  `^(?:[a-f0-9]{64}|file-(?:${uuid}|[a-f0-9]{64})\\.(?:jpe?g|png|gif|webp))-(?:tiny|avatar|thumb|display|ai)-v[0-9]+\\.(?:webp|jpg)$`,
);
const generatedManifest = /^[a-f0-9]{64}-v[0-9]+\.json$/;

/** Only derived files in two explicit cache directories; never visit originals or backups. */
export async function pruneDerivedCaches(
  root: string,
  now = Date.now(),
  budgets = { previews: 512 * 1024 * 1024, manifests: 4 * 1024 * 1024 },
) {
  let removed = 0;
  for (const [directory, pattern, budget] of [
    [join(root, "previews"), generatedPreview, budgets.previews],
    [
      join(root, "uploads", ".reader-cache"),
      generatedManifest,
      budgets.manifests,
    ],
  ] as const) {
    let entries;
    try {
      if (!(await lstat(directory)).isDirectory()) continue;
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const info = await lstat(path);
        if (info.isFile())
          files.push({ path, size: info.size, time: info.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((a, b) => a.time - b.time);
    for (const file of files) {
      // A publication younger than an hour survives even a burst above budget.
      if (
        now - file.time < 3_600_000 ||
        (now - file.time <= 30 * DAY && total <= budget)
      )
        continue;
      try {
        await unlink(file.path);
        total -= file.size;
        removed++;
      } catch (error) {
        if (
          !["ENOENT", "EPERM", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code || "",
          )
        )
          throw error;
      }
    }
  }
  return { removed };
}

export function derivedCacheMaintenance(root: string) {
  let running: Promise<unknown> | undefined;
  const sweep = () => {
    if (running) return;
    running = pruneDerivedCaches(root)
      .catch(() => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "derived_cache_cleanup_failed",
          }),
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  sweep();
  const timer = setInterval(sweep, 6 * 3_600_000);
  timer.unref();
  return {
    close: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
