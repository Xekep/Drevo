import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { postgresAccessReader } from "../../src/server/postgres-access-read.ts";
import { provisionPrivateArchiveInTransaction } from "../../src/server/postgres-private-archive.ts";
import { readPostgresArchiveInTransaction } from "../../src/server/postgres-archive-read.ts";
import type { ArchiveUser, Role, TreeAccess } from "../../src/domain/access.ts";

function sourceUser(row: Record<string, unknown>): ArchiveUser {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    ...(row.last_visit_at ? { lastVisitAt: String(row.last_visit_at) } : {}),
    role: row.role as Role,
    approved: !!row.approved,
    ...(row.person_id ? { personId: String(row.person_id) } : {}),
    treeAccess: (row.tree_access || "all") as TreeAccess,
  };
}

/** Compare effective identity and visibility, not only transferred row counts. */
export async function verifyAccessRead(
  sqlitePath: string,
  archiveId: string,
  client: pg.Client,
  now = Date.now(),
) {
  if (basename(sqlitePath) === "drevo.sqlite")
    throw new Error("Используйте согласованную копию SQLite, а не рабочую БД");
  const databaseName = String(
    (await client.query("SELECT current_database() AS name")).rows[0]?.name ||
      "",
  );
  if (!/^drevo_migration(?:_|$)/.test(databaseName))
    throw new Error("Проверка изоляции разрешена только в migration-базе");
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (
      sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("Копия SQLite повреждена");
    const reader = postgresAccessReader(client, archiveId);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await client.query(
        readFileSync(
          new URL("./005_archive_owner_uniqueness.sql", import.meta.url),
          "utf8",
        ),
      );
      const sourceUsers = sqlite
        .prepare("SELECT * FROM users ORDER BY created_at,id")
        .all()
        .map(sourceUser);
      const importedUsers = await reader.listUsers();
      if (!isDeepStrictEqual(importedUsers, sourceUsers))
        throw new Error("Участники или права PostgreSQL отличаются от SQLite");
      for (const user of sourceUsers) {
        if (!isDeepStrictEqual(await reader.getUser(user.id), user))
          throw new Error("Права участника PostgreSQL отличаются от SQLite");
      }
      const probeArchiveId = `probe-${randomUUID()}`;
      const probeAccountId = randomUUID();
      const probeSessionHash = randomUUID();
      const sharedPersonId = String(
        sqlite.prepare("SELECT id FROM people LIMIT 1").get()?.id ||
          randomUUID(),
      );
      await client.query(
        "INSERT INTO accounts(id,name,created_at) VALUES($1,$2,$3)",
        [probeAccountId, "Проверка изоляции", new Date(now).toISOString()],
      );
      const schemaVersion = Number(
        (
          await client.query(
            "SELECT sqlite_schema_version FROM archives WHERE id=$1",
            [archiveId],
          )
        ).rows[0]?.sqlite_schema_version,
      );
      const provisioned = await provisionPrivateArchiveInTransaction(
        client,
        probeAccountId,
        probeArchiveId,
        "Проверка изоляции",
        schemaVersion,
      );
      if (!provisioned.created || provisioned.archiveId !== probeArchiveId)
        throw new Error("Личный архив не создан");
      const emptyArchive = await readPostgresArchiveInTransaction(
        client,
        probeArchiveId,
      );
      if (
        emptyArchive.revision !== 0 ||
        emptyArchive.family.people.length !== 0 ||
        (emptyArchive.family.links?.length || 0) !== 0 ||
        (emptyArchive.family.photos?.length || 0) !== 0
      )
        throw new Error("Новый личный архив не пустой");
      const privateSettings = await postgresAccessReader(
        client,
        probeArchiveId,
      ).accessSettings();
      if (
        !isDeepStrictEqual(privateSettings, {
          publicTree: false,
          publicAlbums: false,
          reverseTimeline: false,
        })
      )
        throw new Error("Личный архив открыт публично");
      const retry = await provisionPrivateArchiveInTransaction(
        client,
        probeAccountId,
        `${probeArchiveId}-retry`,
        "Повторный вызов",
        schemaVersion,
      );
      if (retry.created || retry.archiveId !== probeArchiveId)
        throw new Error("Повторный вызов создал второй личный архив");
      await client.query(
        "INSERT INTO people(archive_id,id,ordinal,data) VALUES($1,$2,1,$3::jsonb)",
        [
          probeArchiveId,
          sharedPersonId,
          JSON.stringify({ id: sharedPersonId }),
        ],
      );
      await client.query(
        `UPDATE archive_memberships
            SET role='reader',person_id=$3
          WHERE archive_id=$1 AND user_id=$2`,
        [probeArchiveId, probeAccountId, sharedPersonId],
      );
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
        [probeSessionHash, probeAccountId, now + 60_000],
      );
      await client.query(
        "UPDATE archive_tree_settings SET reverse_timeline=true WHERE archive_id=$1",
        [probeArchiveId],
      );
      const otherArchive = postgresAccessReader(client, probeArchiveId);
      if ((await otherArchive.listUsers()).length !== 1)
        throw new Error("Второй архив видит лишних участников");
      if ((await reader.getUser(probeAccountId)) !== null)
        throw new Error("Участник второго архива виден в первом");
      if (
        (await otherArchive.getUser(probeAccountId))?.personId !==
        sharedPersonId
      )
        throw new Error("Участник второго архива потерял свою привязку");
      if (!isDeepStrictEqual(await reader.listUsers(), sourceUsers))
        throw new Error("Участники другого архива попали в список первого");
      for (const user of sourceUsers) {
        if ((await otherArchive.getUser(user.id)) !== null)
          throw new Error("Чужой архив получил доступ к участникам");
      }
      const sessions = sqlite
        .prepare("SELECT token_hash,user_id,expires_at FROM auth_sessions")
        .all();
      if ((await reader.getSessionUser(probeSessionHash, now)) !== null)
        throw new Error("Сессия второго архива открыла первый");
      if (
        (await otherArchive.getSessionUser(probeSessionHash, now))?.id !==
        probeAccountId
      )
        throw new Error("Сессия второго архива не открыла свой архив");
      for (const session of sessions) {
        const expected =
          Number(session.expires_at) > now
            ? (sourceUsers.find(
                (user) => user.id === String(session.user_id),
              ) ?? null)
            : null;
        const actual = await reader.getSessionUser(
          String(session.token_hash),
          now,
        );
        if (!isDeepStrictEqual(actual, expected))
          throw new Error("Доступ по сессии PostgreSQL отличается от SQLite");
        if (
          (await reader.getSessionUser(
            String(session.token_hash),
            Number.MAX_SAFE_INTEGER,
          )) !== null
        )
          throw new Error("Просроченная сессия дала доступ к архиву");
        if (
          (await otherArchive.getSessionUser(
            String(session.token_hash),
            now,
          )) !== null
        )
          throw new Error("Сессия открыла доступ к чужому архиву");
      }
      if ((await reader.getSessionUser("missing-session", now)) !== null)
        throw new Error("Неизвестная сессия дала доступ к архиву");
      const access = sqlite
        .prepare(
          "SELECT public_tree,public_albums FROM access_settings WHERE id=1",
        )
        .get();
      const tree = sqlite
        .prepare("SELECT reverse_timeline FROM tree_settings WHERE id=1")
        .get();
      const expectedSettings =
        access && tree
          ? {
              publicTree: !!access.public_tree,
              publicAlbums: !!access.public_albums,
              reverseTimeline: !!tree.reverse_timeline,
            }
          : null;
      if (!isDeepStrictEqual(await reader.accessSettings(), expectedSettings))
        throw new Error("Настройки видимости PostgreSQL отличаются от SQLite");
      if (
        !isDeepStrictEqual(await otherArchive.accessSettings(), {
          publicTree: false,
          publicAlbums: false,
          reverseTimeline: true,
        })
      )
        throw new Error("Настройки второго архива смешались с первым");
      const sharedAccount = sourceUsers[0];
      if (sharedAccount) {
        const otherRole =
          sharedAccount.role === "reader" ? "relative" : "reader";
        const otherApproval = !sharedAccount.approved;
        const sharedSessionHash = randomUUID();
        await client.query(
          `INSERT INTO archive_memberships
            (archive_id,user_id,role,approved,person_id,tree_access)
           VALUES($1,$2,$3,$4,NULL,'all')`,
          [probeArchiveId, sharedAccount.id, otherRole, otherApproval],
        );
        await client.query(
          "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
          [sharedSessionHash, sharedAccount.id, now + 60_000],
        );
        if (
          !isDeepStrictEqual(
            await reader.getSessionUser(sharedSessionHash, now),
            sharedAccount,
          )
        )
          throw new Error("Сессия потеряла права в исходном архиве");
        const otherIdentity = await otherArchive.getSessionUser(
          sharedSessionHash,
          now,
        );
        if (
          otherIdentity?.role !== otherRole ||
          otherIdentity.approved !== otherApproval ||
          otherIdentity.personId !== undefined
        )
          throw new Error(
            "Права общей учётной записи смешались между архивами",
          );
      }
      await client.query("ROLLBACK");
      return {
        archiveId,
        users: sourceUsers.length,
        sessions: sessions.length,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    sqlite.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [sqlitePath, archiveId] = process.argv.slice(2);
  if (!sqlitePath || !archiveId)
    throw new Error(
      "Использование: verify-access-read.ts <копия.sqlite> <archive_id>",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(
      JSON.stringify(await verifyAccessRead(sqlitePath, archiveId, client)),
    );
  } finally {
    await client.end();
  }
}
