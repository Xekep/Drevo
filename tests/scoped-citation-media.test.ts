import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { authorizeMediaReferences, registerMediaUpload } from "../src/server/media-access.ts";
import type { ArchiveUser, Family, Person, Source } from "../src/domain/index.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";

const citation = (url: string): Source => ({
  title: "Запись", type: "архив", reference: "", url,
});
const person = (id: string, createdBy: string): Person => ({
  id, createdBy, name: id, surname: "Тестов", patronymic: "", sex: "u",
  birth: "", birthPlace: "", parents: [], spouses: [], sources: [],
  generation: 1, column: 0,
});

test("scoped citation binding checks every supported entity without changing old hidden references", async () => {
  const user: ArchiveUser = {
    id: "relative", name: "Участник", role: "relative", approved: true,
    createdAt: "", personId: "anchor", treeAccess: "common_ancestors",
  };
  const anchor = person("anchor", user.id);
  anchor.sources = [citation("/media/visible.png#page=1")];
  const child = person("child", user.id);
  child.parents = [anchor.id];
  child.birth = "1900";
  child.events = [{ id: "event", type: "residence", date: "1920", place: "Москва" }];
  const other = person("other", user.id);
  const outsider = person("outsider", "another-user");
  const hidden = person("hidden", "another-user");
  hidden.sources = [citation("/media/secret.pdf#page=2")];
  hidden.photo = "/media/secret.png";
  const before: Family = {
    title: "Тест", description: "", demo: false,
    people: [anchor, child, other, hidden, outsider], photos: [],
    links: [
      { id: "own-link", createdBy: user.id, type: "godparent", from: "anchor", to: "other" },
      { id: "hidden-link", type: "godparent", from: "hidden", to: "anchor",
        sources: [citation("/media/secret.pdf")] },
    ],
    unions: [
      { id: "own-union", createdBy: user.id, type: "partnership",
        participants: ["anchor", "other"] },
      { id: "hidden-union", type: "partnership", participants: ["hidden", "outsider"],
        sources: [citation("/media/secret.pdf")] },
    ],
  };
  assert.ok(!projectFamilyForUser(before, user).people.some((item) => item.id === hidden.id),
    "the denied citation belongs to a person outside the blood-and-partners scope");
  const archive = await openArchive(":memory:", before);
  const changed = (update: (family: Family) => void) => {
    const family = structuredClone(before);
    update(family);
    return family;
  };
  try {
    const secret = citation("/media/secret.pdf#page=7");
    const bindingCases: Array<[string, (family: Family) => void]> = [
      ["person", (family) => { family.people[1].sources = [secret]; }],
      ["value claim", (family) => { family.people[1].birthDateClaim =
        { value: "1900", sources: [secret] }; }],
      ["alternative", (family) => { family.people[1].factAlternatives =
        [{ id: "alternative", field: "birth", value: "1901", sources: [secret] }]; }],
      ["parent edge", (family) => { family.people[1].parentClaims =
        [{ parentId: "anchor", sources: [secret] }]; }],
      ["award read compatibility", (family) => { family.people[1].awards =
        [{ id: "award", name: "Награда", sources: [secret] }]; }],
      ["event", (family) => { family.people[1].events![0].sources = [secret]; }],
      ["event date", (family) => { family.people[1].events![0].dateClaim =
        { value: "1920", sources: [secret] }; }],
      ["event place", (family) => { family.people[1].events![0].placeClaim =
        { value: "Москва", sources: [secret] }; }],
      ["event alternative", (family) => { family.people[1].events![0].alternatives =
        [{ id: "event-alternative", field: "place", value: "Тверь", sources: [secret] }]; }],
      ["union", (family) => { family.unions![0].sources = [secret]; }],
      ["union stage", (family) => { family.unions![0].formation = { sources: [secret] }; }],
      ["link", (family) => { family.links![0].sources = [secret]; }],
    ];
    for (const [kind, update] of bindingCases)
      await assert.rejects(
        authorizeMediaReferences(archive.db, before, changed(update), user),
        /Нет доступа/, kind,
      );

    const hiddenParent = changed((family) => {
      family.people[1].parents.push("hidden");
      family.people[1].parentClaims = [{ parentId: "hidden", sources: [secret] }];
    });
    assert.deepEqual(projectFamilyForUser(hiddenParent, user).people[1].parentClaims, [],
      "a visible child's hidden parent citation is not in the reader projection");
    const copiedFromHiddenParent = structuredClone(hiddenParent);
    copiedFromHiddenParent.people[1].sources = [secret];
    await assert.rejects(
      authorizeMediaReferences(archive.db, hiddenParent, copiedFromHiddenParent, user),
      /Нет доступа/, "a hidden parent citation cannot become a general card citation",
    );
    const retainedHiddenParent = structuredClone(hiddenParent);
    retainedHiddenParent.people[1].name = "Updated";
    await authorizeMediaReferences(archive.db, hiddenParent, retainedHiddenParent, user);

    await authorizeMediaReferences(archive.db, before,
      changed((family) => { family.people[1].name = "Updated"; }), user);
    await authorizeMediaReferences(archive.db, before,
      changed((family) => { family.people[1].sources =
        [citation("/media/visible.png?variant=original")]; }), user);
    await authorizeMediaReferences(archive.db, before,
      changed((family) => { family.people[1].sources =
        [citation("https://example.test/source")]; }), user);
    await registerMediaUpload(archive.db, "/media/pending.png", user.id, 1);
    await authorizeMediaReferences(archive.db, before,
      changed((family) => { family.people[1].sources =
        [citation("/media/pending.png#page=2")]; }), user);
  } finally {
    await archive.close();
  }
});
