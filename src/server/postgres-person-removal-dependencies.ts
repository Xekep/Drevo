import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { ConflictError } from "./archive-errors.ts";

type Dependencies = {
  tags: { id: string; photo_id: string; person_id: string; data: unknown }[];
  photos: { id: string; data: { url: string } }[];
  documents: { id: string; [key: string]: unknown }[];
  comments: {
    id: string;
    person_id: string;
    author_id: string;
    author_name?: string;
    created_ms: string;
    updated_ms?: string | null;
    text: string;
    attachments?: unknown;
  }[];
};

/** Caller holds archive and person locks. FK inserts cannot race this snapshot. */
export async function capturePersonRemovalDependencies(
  client: pg.Client,
  archiveId: string,
  personId: string,
): Promise<Dependencies> {
  // Do not silently unbind an account or change the scope of its access. An
  // administrator must explicitly unlink it through the access workflow first.
  const bound = await client.query(
    "SELECT user_id FROM archive_memberships WHERE archive_id=$1 AND person_id=$2 FOR UPDATE",
    [archiveId, personId],
  );
  if (bound.rowCount)
    throw new ConflictError(
      "Сначала снимите привязку аккаунта к этому человеку в настройках доступа",
    );
  const tags = await client.query(
    "SELECT id,photo_id,person_id,data FROM photo_tags WHERE archive_id=$1 AND person_id=$2 ORDER BY ordinal FOR UPDATE",
    [archiveId, personId],
  );
  await client.query(
    "SELECT document_id FROM document_people WHERE archive_id=$1 AND person_id=$2 FOR UPDATE",
    [archiveId, personId],
  );
  const documents = await client.query(
    `SELECT d.* FROM documents d JOIN document_people p
       ON p.archive_id=d.archive_id AND p.document_id=d.id
     WHERE p.archive_id=$1 AND p.person_id=$2 ORDER BY d.ordinal FOR SHARE OF d`,
    [archiveId, personId],
  );
  const comments = await client.query(
    "SELECT id,person_id,author_id,author_name,created_ms,text,updated_ms,attachments FROM person_comments WHERE archive_id=$1 AND person_id=$2 ORDER BY id FOR UPDATE",
    [archiveId, personId],
  );
  const photos = await client.query(
    `SELECT id,data FROM photos WHERE archive_id=$1 AND id IN
       (SELECT photo_id FROM photo_tags WHERE archive_id=$1 AND person_id=$2) FOR SHARE`,
    [archiveId, personId],
  );
  return {
    tags: tags.rows,
    photos: photos.rows,
    documents: documents.rows,
    comments: comments.rows,
  };
}

/** Restore only server-captured rows; never overwrite reused IDs or changed files. */
export async function restorePersonRemovalDependencies(
  client: pg.Client,
  archiveId: string,
  personId: string,
  saved: Dependencies,
) {
  const photos = new Map(
    (
      await client.query(
        "SELECT id,data FROM photos WHERE archive_id=$1 AND id=ANY($2::text[]) FOR SHARE",
        [archiveId, saved.photos.map((row) => row.id)],
      )
    ).rows.map((row) => [row.id, row]),
  );
  for (const photo of saved.photos) {
    const current = photos.get(photo.id);
    if (!current || current.data.url !== photo.data.url)
      throw new ConflictError(
        "Фотография удалена или заменена после удаления человека",
      );
  }
  const documents = new Map(
    (
      await client.query(
        "SELECT * FROM documents WHERE archive_id=$1 AND id=ANY($2::text[]) FOR SHARE",
        [archiveId, saved.documents.map((row) => row.id)],
      )
    ).rows.map((row) => [row.id, row]),
  );
  for (const document of saved.documents) {
    const current = documents.get(document.id);
    if (!isDeepStrictEqual(current, document))
      throw new ConflictError(
        "Документ удалён или изменён после удаления человека",
      );
  }
  for (const [table, ids] of [
    ["photo_tags", saved.tags.map((row) => row.id)],
    ["person_comments", saved.comments.map((row) => row.id)],
  ] as const) {
    if (!ids.length) continue;
    const collision = await client.query(
      `SELECT id FROM ${table} WHERE archive_id=$1 AND id=ANY($2::${table === "person_comments" ? "bigint" : "text"}[])`,
      [archiveId, ids],
    );
    if (collision.rowCount)
      throw new ConflictError(
        "Идентификаторы удалённых записей уже заняты; отмена не применена",
      );
  }
  // New ordinals avoid overwriting/reordering data created after the deletion.
  // The operation returns a fresh SQL hydration, including its exact tag order.
  if (saved.tags.length)
    await client.query(
      `INSERT INTO photo_tags(archive_id,id,ordinal,photo_id,person_id,data)
       SELECT $1,r.id,b.ordinal+r.position,r.photo_id,$2,r.data
       FROM jsonb_to_recordset($3::jsonb) AS r(id text,photo_id text,data jsonb,position integer)
       CROSS JOIN (SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM photo_tags WHERE archive_id=$1) b`,
      [
        archiveId,
        personId,
        JSON.stringify(
          saved.tags.map((row, index) => ({ ...row, position: index + 1 })),
        ),
      ],
    );
  if (saved.documents.length)
    await client.query(
      `INSERT INTO document_people(archive_id,ordinal,document_id,person_id)
       SELECT $1,b.ordinal+r.position,r.id,$2
       FROM jsonb_to_recordset($3::jsonb) AS r(id text,position integer)
       CROSS JOIN (SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM document_people WHERE archive_id=$1) b`,
      [
        archiveId,
        personId,
        JSON.stringify(
          saved.documents.map((row, index) => ({
            id: row.id,
            position: index + 1,
          })),
        ),
      ],
    );
  if (saved.comments.length)
    await client.query(
      `INSERT INTO person_comments(archive_id,id,person_id,author_id,author_name,created_ms,text,updated_ms,attachments)
       SELECT $1,r.id,$2,r.author_id,COALESCE(r.author_name,''),r.created_ms,r.text,r.updated_ms,COALESCE(r.attachments,'[]'::jsonb)
       FROM jsonb_to_recordset($3::jsonb) AS r(id bigint,author_id text,author_name text,created_ms bigint,text text,updated_ms bigint,attachments jsonb)`,
      [archiveId, personId, JSON.stringify(saved.comments)],
    );
}
