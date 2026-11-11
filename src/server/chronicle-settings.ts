import type { ArchiveUser } from "../domain/access.ts";
import {
  defaultChronicleSettings,
  validateChronicleSettings,
} from "../shared/chronicle-settings.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  assertCurrentPlatformAdmin,
  PlatformAccessDenied,
} from "./platform-access.ts";
import { auditStore } from "./audit.ts";
import { readFileSync } from "node:fs";
import type pg from "pg";

/** Primary-platform startup only; archive imports never overwrite live globals. */
export async function initializeChronicleConfiguration(
  client: pg.PoolClient,
  primaryArchiveId: string,
) {
  const scope = (
    await client.query("SELECT current_setting('drevo.archive_id',true) AS id")
  ).rows[0]?.id;
  if (!primaryArchiveId || scope !== primaryArchiveId)
    throw new Error(
      "Chronicle platform migration requires the primary archive scope",
    );
  await client.query(
    readFileSync(
      new URL("../../ops/postgres/113_chronicle_settings.sql", import.meta.url),
      "utf8",
    ),
  );
  if (
    (
      await client.query(
        "SELECT 1 FROM platform_config_migrations WHERE version=113",
      )
    ).rowCount
  )
    return;
  if (
    !(
      await client.query("SELECT 1 FROM platform_chronicle_settings WHERE id=1")
    ).rowCount &&
    (
      await client.query(
        "SELECT to_regclass('service_snapshot_rows') AS present",
      )
    ).rows[0]?.present
  ) {
    const legacy = (
      await client.query(
        `SELECT data FROM service_snapshot_rows
      WHERE archive_id=$1 AND table_name='platform_chronicle_settings' AND data->>'id'='1' LIMIT 1`,
        [primaryArchiveId],
      )
    ).rows[0]?.data;
    if (legacy) {
      const settings = validateChronicleSettings(JSON.parse(legacy.data));
      if (
        !Number.isSafeInteger(legacy.version) ||
        legacy.version < 1 ||
        legacy.version >= 2147483647
      )
        throw new RangeError(
          "Некорректная версия импортированных настроек хроники",
        );
      await client.query(
        "INSERT INTO platform_chronicle_settings(id,version,data) VALUES(1,$1,$2::jsonb) ON CONFLICT DO NOTHING",
        [legacy.version, JSON.stringify(settings)],
      );
    }
  }
  await client.query(
    "INSERT INTO platform_config_migrations(version) VALUES(113)",
  );
}

export class ChronicleSettingsConflict extends Error {}
type Session = { accountId: string; tokenHash: string };

export function chronicleSettingsStore(db: StoreDatabase) {
  async function read() {
    const row = await db
      .prepare(
        "SELECT version,data FROM platform_chronicle_settings WHERE id=1",
        "SELECT version,data::text AS data FROM platform_chronicle_settings WHERE id=1",
      )
      .get();
    return {
      version: Number(row?.version || 0),
      settings: row
        ? validateChronicleSettings(JSON.parse(String(row.data)))
        : { ...defaultChronicleSettings },
    };
  }
  async function save(
    input: unknown,
    expected: number,
    actor: ArchiveUser | null,
    session?: Session,
  ) {
    const settings = validateChronicleSettings(input);
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      expected >= 2147483647
    )
      throw new RangeError("Некорректная версия настроек");
    if (db.kind === "postgres") {
      if (!session || !db.postgresTransaction)
        throw new PlatformAccessDenied("Сеанс завершён");
      return db.postgresTransaction(async (client) => {
        await assertCurrentPlatformAdmin(
          client,
          session.accountId,
          session.tokenHash,
        );
        // Also serializes the first insert, when there is no row to lock yet.
        await client.query("SELECT pg_advisory_xact_lock(186743411)");
        const row = (
          await client.query(
            "SELECT version FROM platform_chronicle_settings WHERE id=1 FOR UPDATE",
          )
        ).rows[0];
        if (Number(row?.version || 0) !== expected)
          throw new ChronicleSettingsConflict(
            "Настройки изменены другим администратором. Загрузите их заново",
          );
        await client.query(
          `INSERT INTO platform_chronicle_settings(id,version,data) VALUES(1,$1,$2::jsonb)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data`,
          [expected + 1, JSON.stringify(settings)],
        );
        await client.query(
          "INSERT INTO platform_config_audit(actor_id,action,item_id) VALUES($1,'chronicle_settings_updated','chronicle')",
          [session.accountId],
        );
        return { version: expected + 1, settings };
      });
    }
    if (!actor?.approved || actor.role !== "admin")
      throw new PlatformAccessDenied("Нужны права администратора");
    return db.transaction(async () => {
      if ((await read()).version !== expected)
        throw new ChronicleSettingsConflict(
          "Настройки изменены другим администратором. Загрузите их заново",
        );
      await db
        .prepare(
          `INSERT INTO platform_chronicle_settings(id,version,data) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data`,
        )
        .run(expected + 1, JSON.stringify(settings));
      await auditStore(db).record(
        {
          action: "chronicle_settings_updated",
          entity: "settings",
          entityId: "chronicle",
          label: "Настройки хроники",
          personIds: [],
          details: [],
        },
        actor,
      );
      return { version: expected + 1, settings };
    });
  }
  return { read, save };
}
