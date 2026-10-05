import assert from "node:assert/strict";
import type { openArchive } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAwardCitationPreparation(
  archive: Awaited<ReturnType<typeof openArchive>>,
) {
  const initial = await archive.read();
  const card = initial.family.people.find((person) => person.id === "person-a");
  assert.ok(card, "the disposable runtime fixture has its own card");
  const seeded = structuredClone(card);
  seeded.awards = [{ id: "award-prep", name: "Медаль", sources: [{
    title: "Наградной лист", type: "архив", reference: "л. 2",
  }] }];
  await archive.db.transaction(async () => {
    // Synthetic row models a future release followed by a rollback to A.
    // The public writer is deliberately never used to create this citation.
    await archive.db.prepare("", "UPDATE people SET data=?::jsonb WHERE id=?")
      .run(JSON.stringify({ ...seeded, parents: undefined, parentClaims: undefined,
        spouses: undefined }), seeded.id);
    await archive.db.prepare("", `UPDATE archives SET revision=revision+1
      WHERE id=current_setting('drevo.archive_id',true)`).run();
  });
  const before = await archive.read();
  assert.equal(before.revision, initial.revision + 1);
  assert.equal(before.family.people.find((person) => person.id === card.id)
    ?.awards?.[0].sources?.[0].reference, "л. 2");
  const owner = await (await userStore(archive.db)).get("owner");
  assert.ok(owner?.approved);
  const oldClient = structuredClone(before.family);
  const cardDraft = oldClient.people.find((person) => person.id === card.id)!;
  delete cardDraft.awards![0].sources;
  cardDraft.surname = "Уточнён";
  const saved = await archive.write(oldClient, before.revision, owner);
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.family.people.find((person) => person.id === card.id)
    ?.awards?.[0].sources?.[0].reference, "л. 2");
  assert.equal(cardDraft.awards?.[0].sources, undefined,
    "authorizing the old payload must not mutate it");
  const trusted = structuredClone(saved.family);
  trusted.description = "Независимое изменение";
  const next = await archive.write(trusted, saved.revision);
  assert.equal(next.family.people.find((person) => person.id === card.id)
    ?.awards?.[0].sources?.[0].reference, "л. 2");
  const changed = structuredClone(next.family);
  changed.people.find((person) => person.id === card.id)!
    .awards![0].sources![0].catalogId = "foreign-catalog";
  await assert.rejects(archive.write(changed, next.revision, owner),
    /Цитаты наград пока доступны только для чтения/);
  await assert.rejects(archive.write(changed, next.revision),
    /Цитаты наград пока доступны только для чтения/);
  const removed = structuredClone(next.family);
  removed.people.find((person) => person.id === card.id)!.awards = [];
  await assert.rejects(archive.write(removed, next.revision, owner),
    /Цитаты наград пока доступны только для чтения/);
  const final = await archive.read();
  assert.equal(final.revision, next.revision, "failed writes roll back revision and data");
  assert.equal(final.family.people.find((person) => person.id === card.id)
    ?.awards?.[0].sources?.[0].reference, "л. 2");
}
