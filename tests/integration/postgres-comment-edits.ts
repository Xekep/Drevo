import assert from "node:assert/strict";
import type { PersonComment } from "../../src/shared/person-discussion.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStorageBytes } from "../../src/server/storage-limits.ts";
import { postgresMediaBytes } from "../../src/server/postgres-media-quota.ts";
import sharp from "sharp";

export async function verifyPostgresCommentEdits(
  base: string,
  authorHeaders: Record<string, string | undefined>,
  adminHeaders: Record<string, string | undefined>,
  db: StoreDatabase,
) {
  const headers = (values: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries(values).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const endpoint = `${base}/api/people/person-a/discussion`;
  const countBefore = (
    await (
      await fetch(`${endpoint}?count=1`, { headers: headers(authorHeaders) })
    ).json()
  ).total;
  const userBytesBefore = await userStorageBytes(db, "owner");
  const archiveBytesBefore = await postgresMediaBytes(db);
  const image = await sharp({
    create: { width: 800, height: 400, channels: 3, background: "#abc38e" },
  })
    .png()
    .toBuffer();
  const note = Buffer.from("Примечание из PostgreSQL");
  const created = await fetch(endpoint, {
    method: "POST",
    headers: headers(authorHeaders),
    body: JSON.stringify({
      text: "PG **комментарий** $x^2$",
      attachments: {
        keep: [],
        files: [
          { name: "Скан.png", data: image.toString("base64") },
          { name: "Примечание.txt", data: note.toString("base64") },
        ],
      },
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const original: PersonComment = (await created.json()).item;
  assert.equal(original.editedAt, null);
  assert.equal(original.canEdit, true);
  assert.equal(original.author, "Тестов Иван");
  assert.equal(original.authorPersonId, "person-a");
  assert.equal(original.attachments.length, 2);
  assert.equal(
    await userStorageBytes(db, "owner"),
    userBytesBefore + image.length + note.length,
  );
  assert.equal(
    await postgresMediaBytes(db),
    archiveBytesBefore + image.length + note.length,
  );
  assert.equal(
    (
      await (
        await fetch(`${endpoint}?count=1`, { headers: headers(authorHeaders) })
      ).json()
    ).total,
    countBefore + 1,
  );
  assert.equal((await fetch(base + original.attachments[0].url)).status, 401);
  assert.deepEqual(
    Buffer.from(
      await (
        await fetch(base + original.attachments[0].url, {
          headers: headers(adminHeaders),
        })
      ).arrayBuffer(),
    ),
    image,
  );
  const preview = await fetch(base + original.attachments[0].previewUrl!, {
    headers: headers(adminHeaders),
  });
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal(
    (await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width,
    480,
  );
  await db.transaction(async () => {
    await db
      .prepare("", "SELECT set_config('drevo.archive_id',?,true)")
      .get("unrelated-archive");
    assert.equal(
      (
        await db
          .prepare(
            "",
            "SELECT count(*)::int AS total FROM person_comments WHERE id=?",
          )
          .get(original.id)
      )?.total,
      0,
    );
  }, true);
  const path = `${endpoint}/${original.id}`;
  const patch = (
    text: string,
    editedAt: string | null,
    values = authorHeaders,
  ) =>
    fetch(path, {
      method: "PATCH",
      headers: headers(values),
      body: JSON.stringify({ text, editedAt }),
    });
  assert.equal(
    (await patch("Чужая правка", null, adminHeaders)).status,
    403,
    "administrators cannot rewrite another author's message",
  );
  const attempts = await Promise.all([
    patch("Первая версия", null),
    patch("Вторая версия", null),
  ]);
  assert.deepEqual(
    attempts.map((response) => response.status).sort(),
    [200, 409],
  );
  const edited: PersonComment = (
    await (await attempts.find((response) => response.status === 200)!).json()
  ).item;
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.authorPersonId, "person-a");
  assert.ok(edited.editedAt);
  assert.deepEqual(
    edited.attachments,
    original.attachments,
    "text-only edits preserve the files",
  );
  assert.ok(Date.parse(edited.editedAt) > Date.parse(edited.createdAt));
  const items: PersonComment[] = (
    await (await fetch(endpoint, { headers: headers(adminHeaders) })).json()
  ).items;
  assert.equal(
    items.find((item) => item.id === edited.id)?.editedAt,
    edited.editedAt,
    "the runtime RLS view exposes edit metadata",
  );
  assert.equal(items.find((item) => item.id === edited.id)?.canEdit, false);
  assert.equal(
    items.find((item) => item.id === edited.id)?.authorPersonId,
    "person-a",
  );
  assert.equal((await patch("Устаревшая версия", null)).status, 409);
  assert.equal(
    (await fetch(path, { method: "DELETE", headers: headers(authorHeaders) }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(base + original.attachments[0].url, {
        headers: headers(authorHeaders),
      })
    ).status,
    404,
  );
  assert.equal(await userStorageBytes(db, "owner"), userBytesBefore);
  assert.equal(await postgresMediaBytes(db), archiveBytesBefore);
}
