import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

test("основная SQLite-схема объявляется только в server/schema.ts", () => {
  const directory = resolve("src/server");
  const offenders = readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && name !== "schema.ts")
    .filter((name) =>
      /\bCREATE\s+(?:TABLE|INDEX)\b/i.test(
        readFileSync(resolve(directory, name), "utf8"),
      ),
    );

  assert.deepEqual(
    offenders,
    [],
    "DDL основной SQLite-базы должен добавляться миграцией в server/schema.ts",
  );
});
