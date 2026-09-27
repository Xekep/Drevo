import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { postgresAccessReader } from "../../src/server/postgres-access-read.ts";
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
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (
      sqlite.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("Копия SQLite повреждена");
    const reader = postgresAccessReader(client, archiveId);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
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
      const otherArchive = postgresAccessReader(
        client,
        `${archiveId}-isolation-probe`,
      );
      for (const user of sourceUsers) {
        if ((await otherArchive.getUser(user.id)) !== null)
          throw new Error("Чужой архив получил доступ к участникам");
      }
      const sessions = sqlite
        .prepare("SELECT token_hash,user_id,expires_at FROM auth_sessions")
        .all();
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
      if ((await otherArchive.accessSettings()) !== null)
        throw new Error("Настройки видимости чужого архива доступны");
      await client.query("COMMIT");
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
