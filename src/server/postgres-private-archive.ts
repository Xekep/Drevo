import type pg from "pg";

type PrivateArchive = {
  archiveId: string;
  created: boolean;
};

/** Caller owns the transaction, including account creation and rollback. */
export async function provisionPrivateArchiveInTransaction(
  client: pg.Client,
  ownerId: string,
  archiveId: string,
  title: string,
  sqliteSchemaVersion: number,
): Promise<PrivateArchive> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/.test(archiveId))
    throw new Error("Некорректный archive_id");
  const cleanTitle = title.trim();
  if (!cleanTitle || cleanTitle.length > 160)
    throw new Error("Название архива должно содержать от 1 до 160 символов");
  if (!Number.isSafeInteger(sqliteSchemaVersion) || sqliteSchemaVersion < 1)
    throw new Error("Некорректная версия схемы архива");

  // Serialize duplicate registration callbacks for this owner. The unique
  // owner constraint is the final guard against creating a second tree.
  await client.query("SELECT pg_advisory_xact_lock(2405, hashtext($1))", [
    ownerId,
  ]);
  const account = await client.query(
    "SELECT id FROM accounts WHERE id=$1 FOR UPDATE",
    [ownerId],
  );
  if (!account.rowCount) throw new Error("Аккаунт владельца не найден");
  const existing = await client.query<{ archive_id: string }>(
    "SELECT archive_id FROM archive_owners WHERE user_id=$1",
    [ownerId],
  );
  if (existing.rows[0])
    return { archiveId: existing.rows[0].archive_id, created: false };

  await client.query(
    `INSERT INTO archives
      (id,title,description,demo,revision,sqlite_schema_version)
     VALUES($1,$2,'',false,0,$3)`,
    [archiveId, cleanTitle, sqliteSchemaVersion],
  );
  await client.query(
    `INSERT INTO archive_memberships
      (archive_id,user_id,role,approved,person_id,tree_access)
     VALUES($1,$2,'relative',true,NULL,'all')`,
    [archiveId, ownerId],
  );
  await client.query(
    "INSERT INTO archive_owners(archive_id,user_id) VALUES($1,$2)",
    [archiveId, ownerId],
  );
  await client.query(
    "INSERT INTO archive_access_settings(archive_id,public_tree,public_albums) VALUES($1,false,false)",
    [archiveId],
  );
  await client.query(
    "INSERT INTO archive_tree_settings(archive_id,reverse_timeline) VALUES($1,false)",
    [archiveId],
  );
  return { archiveId, created: true };
}
