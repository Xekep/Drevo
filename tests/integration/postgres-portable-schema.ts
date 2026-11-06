import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../../src/server/schema.ts";
import { portableSnapshotSchema } from "../../src/server/portable-snapshot-schema.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

/** Inspect every real projection even when its table has no rows yet. */
export async function verifyPortableSchema(db: StoreDatabase) {
  assert.ok(db.postgresTransaction);
  const sqlite = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(sqlite);
    const schema = portableSnapshotSchema(sqlite);
    const types: Record<string, ReadonlySet<number>> = {
      // The runtime decodes JSON/JSONB to text and bigint to checked numbers.
      TEXT: new Set([18, 19, 25, 1042, 1043, 114, 3802]),
      INTEGER: new Set([16, 20, 21, 23, 1700]),
      REAL: new Set([20, 21, 23, 700, 701, 1700]),
      BLOB: new Set([17]),
    };
    await db.postgresTransaction(async (client) => {
      await client.query("SET TRANSACTION READ ONLY");
      for (const table of schema) {
        if (!table.select) continue;
        const actual = await client.query(
          `SELECT * FROM (${table.select}) AS portable_contract LIMIT 0`,
        );
        assert.deepEqual(
          actual.fields.map((field) => field.name),
          table.columns.map((column) => column.name),
          table.name,
        );
        table.columns.forEach((column, index) => {
          assert.ok(
            types[column.type]?.has(actual.fields[index].dataTypeID),
            `${table.name}.${column.name}: PostgreSQL OID ${actual.fields[index].dataTypeID} cannot map to SQLite ${column.type}`,
          );
        });
      }
    });
  } finally {
    sqlite.close();
  }
}
