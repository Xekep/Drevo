import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";

type Row = Record<string, unknown>;

function textValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Некорректное поле ${field}`);
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  return value == null ? null : textValue(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`Некорректное поле ${field}`);
  return value === 1;
}

function integerValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`Некорректное поле ${field}`);
  return value;
}

export function planArchiveAccess(users: Row[], explicitOwnerId?: string) {
  const accounts = users.map((row) => ({
    id: textValue(row.id, "users.id"),
    name: textValue(row.name, "users.name"),
    created_at: textValue(row.created_at, "users.created_at"),
    last_visit_at: optionalText(row.last_visit_at, "users.last_visit_at"),
  }));
  const memberships = users.map((row) => ({
    user_id: textValue(row.id, "users.id"),
    role: textValue(row.role, "users.role"),
    approved: booleanValue(row.approved, "users.approved"),
    person_id: optionalText(row.person_id, "users.person_id"),
    tree_access: textValue(row.tree_access, "users.tree_access"),
  }));
  const owners = memberships.filter(
    (member) => member.role === "admin" && member.approved,
  );
  const owner = explicitOwnerId
    ? owners.find((member) => member.user_id === explicitOwnerId)
    : owners.length === 1
      ? owners[0]
      : undefined;
  if (!owner)
    throw new Error(
      `Для переноса нужен ровно один действующий администратор или явно указанный владелец из них; найдено ${owners.length}`,
    );
  return { accounts, memberships, ownerId: owner.user_id };
}

async function shadowRows(client: pg.Client, archiveId: string, name: string) {
  const result = await client.query(
    "SELECT data FROM service_snapshot_rows WHERE archive_id=$1 AND table_name=$2 ORDER BY ordinal",
    [archiveId, name],
  );
  return result.rows.map((row: { data: Row }) => row.data);
}

export async function backfillArchiveAccessInTransaction(
  client: pg.Client,
  archiveId: string,
  ownerUserId?: string,
) {
  const schema = readFileSync(
    join(
      fileURLToPath(new URL(".", import.meta.url)),
      "003_archive_access.sql",
    ),
    "utf8",
  );
  await client.query(schema);
  if ((await client.query("SELECT 1 FROM accounts LIMIT 1")).rowCount)
    throw new Error("Аккаунты уже перенесены; повторный перенос запрещён");
  const sourceUsers = await shadowRows(client, archiveId, "users");
  const { accounts, memberships, ownerId } = planArchiveAccess(
    sourceUsers,
    ownerUserId,
  );
  for (const account of accounts)
    await client.query(
      "INSERT INTO accounts(id,name,created_at,last_visit_at) VALUES($1,$2,$3,$4)",
      [account.id, account.name, account.created_at, account.last_visit_at],
    );
  for (const member of memberships)
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,person_id,tree_access) VALUES($1,$2,$3,$4,$5,$6)",
      [
        archiveId,
        member.user_id,
        member.role,
        member.approved,
        member.person_id,
        member.tree_access,
      ],
    );
  await client.query(
    "INSERT INTO archive_owners(archive_id,user_id) VALUES($1,$2)",
    [archiveId, ownerId],
  );

  const sourceSessions = await shadowRows(client, archiveId, "auth_sessions");
  const sessions = sourceSessions.map((row) => ({
    token_hash: textValue(row.token_hash, "auth_sessions.token_hash"),
    user_id: textValue(row.user_id, "auth_sessions.user_id"),
    expires_at: integerValue(row.expires_at, "auth_sessions.expires_at"),
  }));
  for (const session of sessions)
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [session.token_hash, session.user_id, session.expires_at],
    );

  const sourceAccess = await shadowRows(client, archiveId, "access_settings");
  if (sourceAccess.length > 1)
    throw new Error("Несколько строк access_settings");
  const access = sourceAccess.map((row) => ({
    public_tree: booleanValue(row.public_tree, "access_settings.public_tree"),
    public_albums: booleanValue(
      row.public_albums,
      "access_settings.public_albums",
    ),
  }));
  if (access[0])
    await client.query(
      "INSERT INTO archive_access_settings(archive_id,public_tree,public_albums) VALUES($1,$2,$3)",
      [archiveId, access[0].public_tree, access[0].public_albums],
    );

  const sourceTree = await shadowRows(client, archiveId, "tree_settings");
  if (sourceTree.length > 1) throw new Error("Несколько строк tree_settings");
  const tree = sourceTree.map((row) => ({
    reverse_timeline: booleanValue(
      row.reverse_timeline,
      "tree_settings.reverse_timeline",
    ),
  }));
  if (tree[0])
    await client.query(
      "INSERT INTO archive_tree_settings(archive_id,reverse_timeline) VALUES($1,$2)",
      [archiveId, tree[0].reverse_timeline],
    );

  const actualUsers = (
    await client.query(
      `SELECT a.id,a.name,a.created_at,a.last_visit_at,
              m.role,m.approved,m.person_id,m.tree_access
         FROM archive_memberships m JOIN accounts a ON a.id=m.user_id
        WHERE m.archive_id=$1`,
      [archiveId],
    )
  ).rows;
  const expectedUsers = accounts.map((account, index) => ({
    ...account,
    role: memberships[index].role,
    approved: memberships[index].approved,
    person_id: memberships[index].person_id,
    tree_access: memberships[index].tree_access,
  }));
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (!isDeepStrictEqual(actualUsers.sort(byId), expectedUsers.sort(byId)))
    throw new Error("Аккаунты или права отличаются после переноса");
  const actualSessions = (
    await client.query(
      "SELECT token_hash,user_id,expires_at FROM account_sessions ORDER BY token_hash",
    )
  ).rows.map((row: Row) => ({
    ...row,
    expires_at: Number(row.expires_at),
  }));
  if (
    !isDeepStrictEqual(
      actualSessions,
      sessions.sort((a, b) => a.token_hash.localeCompare(b.token_hash)),
    )
  )
    throw new Error("Сессии отличаются после переноса");
  const actualAccess = (
    await client.query(
      "SELECT public_tree,public_albums FROM archive_access_settings WHERE archive_id=$1",
      [archiveId],
    )
  ).rows;
  if (!isDeepStrictEqual(actualAccess, access))
    throw new Error("Настройки доступа отличаются после переноса");
  const actualTree = (
    await client.query(
      "SELECT reverse_timeline FROM archive_tree_settings WHERE archive_id=$1",
      [archiveId],
    )
  ).rows;
  if (!isDeepStrictEqual(actualTree, tree))
    throw new Error("Настройки древа отличаются после переноса");
  return {
    accounts: accounts.length,
    memberships: memberships.length,
    sessions: sessions.length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [archiveId, ownerUserId] = process.argv.slice(2);
  if (!archiveId)
    throw new Error(
      "Использование: backfill-archive-access.ts <archive_id> [owner_user_id]",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const result = await backfillArchiveAccessInTransaction(
        client,
        archiveId,
        ownerUserId,
      );
      await client.query("COMMIT");
      console.log(JSON.stringify(result));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}
