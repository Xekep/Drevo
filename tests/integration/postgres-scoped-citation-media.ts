import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { openArchive } from "../../src/server/database.ts";
import type { ArchiveUser, Family, Person, Source } from "../../src/domain/index.ts";
import { authorizeMediaReferences } from "../../src/server/media-access.ts";

/** The same entity-bound media check must run under archive RLS in PostgreSQL. */
export async function verifyPostgresScopedCitationMedia(
  archive: Awaited<ReturnType<typeof openArchive>>,
) {
  const seed = (await archive.read()).family.people[0];
  assert.ok(seed);
  const person = (id: string, createdBy: string): Person => ({
    ...seed, id, createdBy, parents: [], spouses: [], sources: [],
    parentClaims: undefined, photo: undefined, awards: undefined, events: undefined,
  });
  const media = `/media/${randomUUID()}.pdf`;
  const source: Source = { title: "Запись", type: "архив", reference: "", url: `${media}#page=2` };
  const before: Family = {
    title: "Scoped citation", description: "", demo: false,
    people: [person("scoped-citation-own", "reader"),
      { ...person("scoped-citation-hidden", "owner"), sources: [source] }],
    photos: [],
  };
  const after = structuredClone(before);
  after.people[0].sources = [{ ...source, url: `${media}?page=7` }];
  const actor: ArchiveUser = {
    id: "reader", name: "Reader", role: "relative", approved: true,
    createdAt: "", personId: "scoped-citation-own", treeAccess: "common_ancestors",
  };
  await assert.rejects(archive.db.transaction(async () =>
    await authorizeMediaReferences(archive.db, before, after, actor)),
  /Нет доступа/, "a hidden URL cannot be moved to the scoped person's citation");
  console.log("runtime_scoped_citation_media_ok");
}
