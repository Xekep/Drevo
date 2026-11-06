import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupProcess } from "../src/server/backup-process.ts";
import {
  backupWorkerFailure,
  backupWorkerFailureMessage,
  readBackupWorkerFailure,
} from "../src/server/backup-worker-failure.ts";

test("worker shutdown cancellation is distinct from a backup failure and does not emit a false error", async t => {
  const logs: string[] = [];
  t.mock.method(console, "error", (value: string) => logs.push(value));
  const controller = new AbortController();
  const pending = backupProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], controller.signal,
    undefined, { workerDiagnostics: true });
  controller.abort();
  await assert.rejects(pending, /отменено/);
  assert.deepEqual(logs, []);
});

test("a worker deadline kills the child and reports an interruption without raw process output", async t => {
  const logs: string[] = [];
  t.mock.method(console, "error", (value: string) => logs.push(value));
  await assert.rejects(backupProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"],
    new AbortController().signal, 100, { workerDiagnostics: true }), /прервано/);
  assert.equal(logs.length, 1);
});

test("backup failures classify PostgreSQL and SQLite errors without copying private messages", () => {
  for (const [error, expected] of [
    [{ code: "42703", message: "private SQL and secret value" }, "schema"],
    [{ code: "28P01", message: "password=private" }, "database"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 13 }, "disk-full"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 14 }, "permission"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 787 }, "foreign-keys"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 11 }, "integrity"],
    [new Error("private message with token"), "unknown"],
  ] as const) {
    const failure = backupWorkerFailure(error, "snapshot");
    assert.equal(failure.code, expected);
    assert.doesNotMatch(
      JSON.stringify(failure) + backupWorkerFailureMessage(failure),
      /private|password|token/,
    );
  }
  const field = backupWorkerFailure(
    new Error("Некорректное поле копии: published_people.birth_year_visible"),
    "snapshot",
  );
  assert.equal(field.code, "invalid-value");
  assert.match(
    backupWorkerFailureMessage(field),
    /published_people.birth_year_visible/,
  );
});

test("worker IPC accepts only bounded known diagnostics and discards extra secret fields", () => {
  const valid = {
    type: "backup-worker-failure",
    version: 1,
    stage: "snapshot",
    code: "invalid-value",
  };
  assert.equal(
    readBackupWorkerFailure({ ...valid, stage: "password=private" }),
    null,
  );
  assert.equal(readBackupWorkerFailure({ ...valid, code: "private" }), null);
  assert.deepEqual(
    readBackupWorkerFailure({
      ...valid,
      field: "private/path",
      stderr: "secret",
      sql: "secret",
    }),
    valid,
  );
  assert.deepEqual(
    readBackupWorkerFailure({
      ...valid,
      field: "people.data",
      stack: "secret",
    }),
    { ...valid, field: "people.data" },
  );
});

test("local worker failure reaches the caller through safe IPC while raw output stays hidden", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (value: string) => logs.push(value));
  const packet = {
    type: "backup-worker-failure",
    version: 1,
    stage: "snapshot",
    code: "schema",
    stderr: "private-password",
  };
  const script = `console.error('private-password');process.send(${JSON.stringify(packet)},()=>process.exit(1));`;
  await assert.rejects(
    backupProcess(
      process.execPath,
      ["-e", script],
      new AbortController().signal,
      undefined,
      { workerDiagnostics: true },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Схема данных/);
      assert.doesNotMatch(error.message, /private|password|node\.exe/);
      return true;
    },
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /backup_worker_failed/);
  assert.doesNotMatch(logs[0], /private|password|stderr/);
});

test("actual snapshot worker identifies its opening failure without disclosing filenames", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "error", (value: string) => logs.push(value));
  const directory = await mkdtemp(
    join(tmpdir(), "drevo-backup-worker-failure-"),
  );
  try {
    await assert.rejects(
      backupProcess(
        process.execPath,
        [
          fileURLToPath(
            new URL("../src/server/backup-worker.mjs", import.meta.url),
          ),
          join(directory, "missing.sqlite"),
          join(directory, "copy.sqlite"),
          "",
          "tree",
        ],
        new AbortController().signal,
        undefined,
        { workerDiagnostics: true },
      ),
      /Подключение к данным: Нет доступа/,
    );
    assert.equal(JSON.parse(logs[0]).stage, "open");
    assert.doesNotMatch(logs.join(""), /missing\.sqlite|copy\.sqlite/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generic backup commands keep stderr private and unsuccessful workers cannot report success", async (t) => {
  t.mock.method(console, "error", () => {});
  await backupProcess(
    process.execPath,
    ["-e", "process.exit(0)"],
    new AbortController().signal,
  );
  await assert.rejects(
    backupProcess(
      process.execPath,
      ["-e", "console.error('private-key');process.exit(1)"],
      new AbortController().signal,
    ),
    (error) => error instanceof Error && !error.message.includes("private-key"),
  );
  await assert.rejects(
    backupProcess(
      process.execPath,
      ["-e", "process.exit(1)"],
      new AbortController().signal,
      undefined,
      { workerDiagnostics: true },
    ),
    /Создание переносимой копии прервано/,
  );
});
