import assert from "node:assert/strict";
import type { PersonComment } from "../../src/shared/person-discussion.ts";

export async function verifyPostgresCommentEdits(
  base: string,
  authorHeaders: Record<string, string | undefined>,
  adminHeaders: Record<string, string | undefined>,
) {
  const headers = (values: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries(values).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  const endpoint = `${base}/api/people/person-a/discussion`;
  const created = await fetch(endpoint, {
    method: "POST",
    headers: headers(authorHeaders),
    body: JSON.stringify({ text: "PG **комментарий** $x^2$" }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const original: PersonComment = (await created.json()).item;
  assert.equal(original.editedAt, null);
  assert.equal(original.canEdit, true);
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
  assert.ok(edited.editedAt);
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
  assert.equal((await patch("Устаревшая версия", null)).status, 409);
  assert.equal(
    (await fetch(path, { method: "DELETE", headers: headers(authorHeaders) }))
      .status,
    200,
  );
}
