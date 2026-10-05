import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { openArchive } from "../../src/server/database.ts";
import type { ArchiveUser, Family, Person, Source } from "../../src/domain/index.ts";
import { authorizeMediaReferences } from "../../src/server/media-access.ts";
import { recordMediaOriginal } from "../../src/server/media-originals.ts";

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
      { ...person("scoped-citation-hidden", "owner"), sources: [source] },
      person("scoped-citation-other", "reader")],
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
  await archive.db.transaction(async () => {
    const ownUrl = `/media/${randomUUID()}.pdf`;
    const parentUrl = `/media/${randomUUID()}.pdf`;
    const foreignUrl = `/media/${randomUUID()}.pdf`;
    const ownSource: Source = { ...source, url: `${ownUrl}#page=2` };
    const historical = structuredClone(before);
    historical.people[0].sources = [ownSource, { ...source, url: foreignUrl }];
    historical.people[0].parentClaims = [{ parentId: "scoped-citation-hidden",
      sources: [{ ...source, url: parentUrl }] }];
    const revision = Number((await archive.db.prepare("",
      "SELECT COALESCE(max(revision),0)+1000000 AS rev FROM history").get())?.rev);
    await recordMediaOriginal(archive.db, ownUrl, 123, actor.id);
    await recordMediaOriginal(archive.db, parentUrl, 17, actor.id);
    await recordMediaOriginal(archive.db, foreignUrl, 17, "owner");
    await archive.db.prepare("", "INSERT INTO history(revision,data) VALUES(?,?)")
      .run(revision, JSON.stringify(historical));
    try {
      const restored = structuredClone(before);
      restored.people[0].sources = [{ ...ownSource, url: `${ownUrl}?page=7` }];
      await authorizeMediaReferences(archive.db, before, restored, actor);
      const crossCard = structuredClone(before);
      crossCard.people[2].sources = [ownSource];
      await assert.rejects(authorizeMediaReferences(archive.db, before, crossCard, actor),
        /Нет доступа/, "own original history does not authorize another card");
      const copiedParent = structuredClone(before);
      copiedParent.people[0].sources = [{ ...source, url: parentUrl }];
      await assert.rejects(authorizeMediaReferences(archive.db, before, copiedParent, actor),
        /Нет доступа/, "a parent-claim source does not become a general card source");
      const foreignOriginal = structuredClone(before);
      foreignOriginal.people[0].sources = [{ ...source, url: foreignUrl }];
      await assert.rejects(authorizeMediaReferences(archive.db, before, foreignOriginal, actor),
        /Нет доступа/, "history cannot restore someone else's original");
    } finally {
      await archive.db.prepare("", "DELETE FROM history WHERE revision=?").run(revision);
      await archive.db.prepare("", "DELETE FROM media_originals WHERE url IN (?,?,?)")
        .run(ownUrl, parentUrl, foreignUrl);
    }
  });
  console.log("runtime_scoped_citation_media_ok");
}
