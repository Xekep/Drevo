import { copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [backup, release, previous] = process.argv.slice(2);
if (!backup || !release)
  throw new Error("Usage: check-migration.mjs backup release [previous]");
const temporary = mkdtempSync(
  join(dirname(resolve(backup)), ".migration-check-"),
);
const database = join(temporary, "drevo.sqlite");
try {
  copyFileSync(backup, database);
  for (const root of [release, previous].filter(Boolean)) {
    const entry = join(resolve(root), "src/server/index.ts");
    if (!existsSync(entry)) throw new Error("Release entry point is missing");
    // Start both releases against the migrated COPY. An incompatible rollback
    // aborts deployment before the live symlink or database is touched.
    const code = `
      const { startServer } = await import(${JSON.stringify(pathToFileURL(entry).href)});
      const app = await startServer(0, ${JSON.stringify(database)}, true);
      try {
        const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/health');
        if (!response.ok || !(await response.json()).ok) throw new Error('Health check failed');
        const checks = app.archive.db.prepare('PRAGMA integrity_check').all();
        if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('Database integrity check failed');
        if (app.archive.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign keys are invalid');
      } finally { await app.close(); }
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PUBLIC_ORIGIN: "https://migration-check.invalid",
          INITIAL_ADMIN_YANDEX_ID: "migration-check",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Migration/rollback preflight failed for ${root}: ${result.error?.message || result.stderr}`,
      );
  }
  console.log(
    "Migration and previous-release compatibility verified on an isolated database copy",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
