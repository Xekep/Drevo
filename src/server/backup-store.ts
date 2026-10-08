import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { AuditDraft } from "../domain/audit.ts";
import type pg from "pg";
import type {
  BackupRecord,
  BackupSettings,
} from "../shared/backup-management.ts";
import { auditStore } from "./audit.ts";
const hour = 3600000;
const defaults: BackupSettings = {
  enabled: true,
  intervalHours: 24,
  keepCount: 30,
  storage: "local",
  remoteHost: "",
  remoteDirectory: "",
};

export class BackupInputError extends Error {}

export function validateBackupSettings(value: unknown): BackupSettings {
  const v = value as BackupSettings;
  if (
    !v ||
    typeof v.enabled !== "boolean" ||
    !Number.isInteger(v.intervalHours) ||
    v.intervalHours < 1 ||
    v.intervalHours > 720 ||
    !Number.isInteger(v.keepCount) ||
    v.keepCount < 1 ||
    v.keepCount > 365 ||
    !["local", "remote"].includes(v.storage) ||
    typeof v.remoteHost !== "string" ||
    typeof v.remoteDirectory !== "string"
  )
    throw new BackupInputError(
      "Укажите период от 1 до 720 часов и количество копий от 1 до 365.",
    );
  const host = v.remoteHost.trim(),
    path = v.remoteDirectory.trim().replace(/\/+$/, "");
  if (
    (host && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(host)) ||
    (path &&
      (!/^\/[a-zA-Z0-9_./-]{1,240}$/.test(path) ||
        path.split("/").some((p) => p === ".." || p === "."))) ||
    (v.storage === "remote" && (!host || !path))
  )
    throw new BackupInputError(
      "Укажите имя SSH-подключения и абсолютный каталог на отдельном сервере (без пробелов и ..).",
    );
  return {
    enabled: v.enabled,
    intervalHours: v.intervalHours,
    keepCount: v.keepCount,
    storage: v.storage,
    remoteHost: host,
    remoteDirectory: path,
  };
}

export async function backupStore(db: StoreDatabase, now = Date.now, treeOnly = false) {
  const audit = auditStore(db);
  await db
    .prepare(
      "INSERT OR IGNORE INTO backup_settings VALUES(1,?,?)",
      "INSERT INTO backup_settings(id,data,next_run) VALUES(1,?,?) ON CONFLICT DO NOTHING",
    )
    .run(JSON.stringify(defaults), now() + 24 * hour);
  async function settings() {
    const row = (await db
      .prepare(
        "SELECT data,next_run FROM backup_settings WHERE id=1",
        "SELECT data,next_run FROM backup_settings WHERE id=1",
      )
      .get())!;
    return {
      value: treeOnly ? { ...defaults, enabled: false, keepCount: 5 } : JSON.parse(String(row.data)) as BackupSettings,
      next: Number(row.next_run),
    };
  }
  async function save(value: unknown, actor: ArchiveUser) {
    const checked = validateBackupSettings(value),
      old = await settings();
    const next = nextRun(checked, old.value, old.next);
    await db
      .prepare(
        "UPDATE backup_settings SET data=?,next_run=? WHERE id=1",
        "UPDATE backup_settings SET data=?,next_run=? WHERE id=1",
      )
      .run(JSON.stringify(checked), next);
    await audit.record(settingAudit(old.value, checked), actor);
    return checked;
  }
  function nextRun(checked: BackupSettings, old: BackupSettings, previous: number) {
    return checked.enabled !== old.enabled ||
      checked.intervalHours !== old.intervalHours
        ? now() + checked.intervalHours * hour
        : previous;
  }
  function settingAudit(before: BackupSettings, after: BackupSettings): AuditDraft {
    return {
      action: "Настроены резервные копии",
      entity: "settings",
      entityId: "backups",
      label: "Резервные копии",
      personIds: [],
      details: [
        {
          field: "Настройки",
          before: JSON.stringify(before),
          after: JSON.stringify(after),
        },
      ],
    };
  }
  async function savePostgres(value: unknown, actor: ArchiveUser, client: pg.PoolClient) {
    if (db.kind !== "postgres") throw new Error("PostgreSQL is required");
    const checked = validateBackupSettings(value);
    const previous = await client.query<{ data: string; next_run: string }>(
      `SELECT data,next_run FROM backup_settings
       WHERE archive_id=$1 AND id=1 FOR UPDATE NOWAIT`, [db.archiveId]);
    if (!previous.rows[0]) throw new Error("Backup settings are unavailable");
    const old = JSON.parse(String(previous.rows[0].data)) as BackupSettings;
    const next = nextRun(checked, old, Number(previous.rows[0].next_run));
    await client.query(
      "UPDATE backup_settings SET data=$1,next_run=$2 WHERE archive_id=$3 AND id=1",
      [JSON.stringify(checked), next, db.archiveId]);
    const draft = settingAudit(old, checked);
    await client.query(
      `INSERT INTO archive_audit_entries
       (archive_id,at,actor_id,actor_name,action,entity,entity_id,label,revision,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
      [db.archiveId, new Date().toISOString(), actor.id, actor.name,
        draft.action, draft.entity, draft.entityId, draft.label,
        JSON.stringify(draft.details)],
    );
    return checked;
  }
  async function record(id: string): Promise<BackupRecord> {
    const row = await db
      .prepare(
        "SELECT data FROM backup_catalog WHERE id=?",
        "SELECT data FROM backup_catalog WHERE id=?",
      )
      .get(id);
    if (!row)
      throw new BackupInputError(
        "Резервная копия не найдена. Обновите список.",
      );
    const r = JSON.parse(String(row.data)) as BackupRecord;
    if (treeOnly && !r.name.startsWith("tree-")) throw new BackupInputError("Копия не относится к ручным копиям древа.");
    return r;
  }

  async function add(item: BackupRecord) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO backup_catalog VALUES(?,?,?,?)",
        "INSERT INTO backup_catalog(id,name,created_at,data) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(item.id, item.name, item.createdAt, JSON.stringify(item));
  }
  async function excess(config: BackupSettings) {
    return (
      await db
        .prepare(
          `SELECT data FROM backup_catalog WHERE name LIKE '${treeOnly ? "tree-%" : "%"}' ORDER BY created_at DESC,id DESC`,
          `SELECT data FROM backup_catalog WHERE name LIKE '${treeOnly ? "tree-%" : "%"}' ORDER BY created_at DESC,id DESC`,
        )
        .all()
    )
      .map((row) => JSON.parse(String(row.data)) as BackupRecord)
      .filter((item) => !treeOnly || item.name.startsWith("tree-"))
      .filter(
        (item) =>
          item.storage === config.storage &&
          (item.storage === "local" ||
            (item.remoteHost === config.remoteHost &&
              item.remoteDirectory === config.remoteDirectory)),
      )
      .slice(config.keepCount);
  }
  return {
    settings,
    save,
    savePostgres,
    record,
    add,
    excess,
    async list(offset: number) {
      return {
        records: (
          await db
            .prepare(
              `SELECT data FROM backup_catalog WHERE name LIKE '${treeOnly ? "tree-%" : "%"}' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?`,
              `SELECT data FROM backup_catalog WHERE name LIKE '${treeOnly ? "tree-%" : "%"}' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?`,
            )
            .all(offset)
        ).map((row) => JSON.parse(String(row.data)) as BackupRecord),
        total: Number(
          (await db
            .prepare(
              `SELECT count(*) AS n FROM backup_catalog WHERE name LIKE '${treeOnly ? "tree-%" : "%"}'`,
              `SELECT count(*) AS n FROM backup_catalog WHERE name LIKE '${treeOnly ? "tree-%" : "%"}'`,
            )
            .get())!.n,
        ),
      };
    },
    async forget(id: string) {
      await db
        .prepare(
          "DELETE FROM backup_catalog WHERE id=?",
          "DELETE FROM backup_catalog WHERE id=?",
        )
        .run(id);
    },
    async schedule(next: number) {
      await db
        .prepare(
          "UPDATE backup_settings SET next_run=? WHERE id=1",
          "UPDATE backup_settings SET next_run=? WHERE id=1",
        )
        .run(next);
    },
    async retryBy(next: number) {
      await db
        .prepare(
          "UPDATE backup_settings SET next_run=min(next_run,?) WHERE id=1",
          "UPDATE backup_settings SET next_run=min(next_run,?) WHERE id=1",
        )
        .run(next);
    },
  };
}
