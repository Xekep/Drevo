import assert from "node:assert/strict";
import type { openArchive } from "../../src/server/database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAwardCitationActivation(
  archive: Awaited<ReturnType<typeof openArchive>>,
) {
  const initial = await archive.read();
  const card = initial.family.people.find((person) => person.id === "person-a");
  assert.ok(card, "the disposable runtime fixture has its own card");
  const added = structuredClone(initial.family);
  added.people.find((person) => person.id === card.id)!.awards = [{ id: "award-prep", name: "Медаль", sources: [{
    title: "Наградной лист", type: "архив", reference: "л. 2",
  }] }];
  await archive.write(added, initial.revision);
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
    /Источник отсутствует|каталожный/i);
  await assert.rejects(archive.write(changed, next.revision),
    /Источник отсутствует|каталожный/i);
  const removed = structuredClone(next.family);
  removed.people.find((person) => person.id === card.id)!.awards = [];
  const afterRemoval = await archive.write(removed, next.revision, owner);
  assert.equal(afterRemoval.family.people.find((person) => person.id === card.id)!.awards?.length, 0);
  const final = await archive.read();
  assert.equal(final.revision, next.revision + 1, "failed foreign-link writes do not advance revision");
  assert.deepEqual(final.family.people.find((person) => person.id === card.id)?.awards, []);
}
