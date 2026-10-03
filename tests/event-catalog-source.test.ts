import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { retypeEvent } from "../src/domain/person-events.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import {
  sourceCitation,
  type CatalogSource,
} from "../src/shared/source-catalog.ts";

const catalogSource: CatalogSource = {
  id: "event-register",
  title: "Книга переселенцев",
  type: "архив",
  author: "",
  institution: "",
  archive: "ГАСО",
  fond: "6",
  opis: "",
  delo: "104",
  sheet: "",
  reference: "Ф. 6, Д. 104",
  url: "",
  accessedAt: "",
  description: "",
  documentIds: [],
};
const actor = (role: ArchiveUser["role"]): ArchiveUser => ({
  id: "owner",
  name: "Владелец",
  role,
  createdAt: "2026-01-01",
});
const family = (): Family => ({
  title: "Семья",
  description: "",
  demo: false,
  people: [
    {
      id: "anna",
      name: "Анна",
      surname: "Тестова",
      patronymic: "",
      sex: "f",
      birth: "1880",
      birthPlace: "Тула",
      parents: [],
      spouses: [],
      generation: 1,
      column: 0,
      sources: [],
      createdBy: "owner",
      events: [
        {
          id: "move",
          type: "move",
          date: "1901",
          place: "Москва",
          sources: [
            { title: "Семейная запись", type: "рукопись", reference: "л. 2" },
          ],
        },
      ],
    },
  ],
});

test("event catalog link requires an admin, while inline editing and retained links remain allowed", () => {
  const before = family();
  const linked = structuredClone(before);
  linked.people[0].events![0].sources!.push(sourceCitation(catalogSource));
  assert.throws(
    () => authorizeArchive(linked, before, actor("relative")),
    /только администратор/,
  );
  assert.throws(
    () => authorizeArchive(linked, before, actor("researcher")),
    /только администратор/,
  );
  assert.equal(
    authorizeArchive(linked, before, actor("admin")).people[0].events?.[0]
      .sources?.[1].catalogId,
    catalogSource.id,
  );
  assert.equal(
    linked.people[0].birthDateClaim,
    undefined,
    "an event citation does not assess the exact date",
  );
  assert.equal(
    linked.people[0].birthPlaceClaim,
    undefined,
    "an event citation does not assess the exact place",
  );
  const edited = structuredClone(linked);
  edited.people[0].events![0].sources![0].reference = "л. 3";
  assert.equal(
    authorizeArchive(edited, linked, actor("relative")).people[0].events?.[0]
      .sources?.[0].reference,
    "л. 3",
  );
  const duplicated = structuredClone(linked);
  duplicated.people[0].events![0].sources!.push(sourceCitation(catalogSource));
  assert.throws(() => authorizeArchive(duplicated, linked, actor("relative")),
    /только администратор/);
  const moved = structuredClone(linked);
  moved.people[0].sources.push(moved.people[0].events![0].sources!.pop()!);
  assert.throws(() => authorizeArchive(moved, linked, actor("relative")),
    /только администратор/);
  const forged = structuredClone(linked);
  forged.people[0].events![0].sources![1].title = "Подмена названия";
  assert.throws(() => authorizeArchive(forged, linked, actor("relative")),
    /Изменить каталожную цитату/);
  edited.people[0].events![0].sources!.pop();
  assert.equal(
    authorizeArchive(edited, linked, actor("relative")).people[0].events?.[0]
      .sources?.length,
    1,
  );
});

test("changing a cited event's identity cannot reuse evidence for a different event", () => {
  const evidence = [
    (value: Family) => { value.people[0].events![0].sources = [
      { title: "Move record", type: "archive", reference: "1" }]; },
    (value: Family) => { value.people[0].events![0].dateClaim = {
      value: "1901", sources: [{ title: "Move date", type: "archive", reference: "2" }] }; },
    (value: Family) => { value.people[0].events![0].placeClaim = {
      value: "Москва", sources: [{ title: "Move place", type: "archive", reference: "3" }] }; },
    (value: Family) => { value.people[0].events![0].alternatives = [
      { id: "alternate-place", field: "place", value: "Тула",
        sources: [{ title: "Other move place", type: "archive", reference: "4" }] }]; },
  ];
  for (const addEvidence of evidence) {
    const before = family();
    before.people[0].events![0].sources = [];
    addEvidence(before);
    const reclassified = structuredClone(before);
    reclassified.people[0].events![0].type = "military";
    assert.throws(() => authorizeArchive(reclassified, before, actor("admin")),
      /снимите прежние источники события/);
    const transition = retypeEvent(before.people[0].events![0], "military");
    assert.equal(transition.removedEvidence, true);
    const clean = structuredClone(before);
    clean.people[0].events![0] = transition.event;
    assert.doesNotThrow(() => authorizeArchive(clean, before, actor("admin")));
    const retitled = structuredClone(before);
    retitled.people[0].events![0].title = "Переезд в Москву";
    assert.doesNotThrow(() => authorizeArchive(retitled, before, actor("researcher")));
  }
  const imported = family();
  imported.people[0].events![0].sources = [];
  imported.people[0].events![0].gedcomTag = "RESI";
  const staleTag = structuredClone(imported);
  staleTag.people[0].events![0].type = "military";
  assert.throws(() => authorizeArchive(staleTag, imported, actor("admin")),
    /прежний тип GEDCOM/);
  const transitioned = retypeEvent(imported.people[0].events![0], "military");
  assert.equal(transitioned.event.gedcomTag, undefined);
  assert.equal(transitioned.removedEvidence, false);
  staleTag.people[0].events![0] = transitioned.event;
  assert.doesNotThrow(() => authorizeArchive(staleTag, imported, actor("admin")));
});

test("non-admin cannot add catalog citations to any person, claim, event, or union slot", () => {
  const before = family();
  before.people[0].death = "1950";
  before.people[0].deathPlace = "Казань";
  before.people.push({ ...structuredClone(before.people[0]), id: "boris", name: "Борис",
    events: [], sources: [] });
  before.unions = [
    { id: "first", participants: ["anna", "boris"], type: "marriage", createdBy: "owner",
      formation: {}, ending: {}, ongoing: {} },
    { id: "second", participants: ["anna", "boris"], type: "marriage", createdBy: "owner",
      divorce: {} },
  ];
  const cases: Array<[string, (value: Family) => void]> = [
    ["person", (value) => value.people[0].sources.push(sourceCitation(catalogSource))],
    ["birth date", (value) => { value.people[0].birthDateClaim = {
      value: "1880", sources: [sourceCitation(catalogSource)] }; }],
    ["death date", (value) => { value.people[0].deathDateClaim = {
      value: "1950", sources: [sourceCitation(catalogSource)] }; }],
    ["birth place", (value) => { value.people[0].birthPlaceClaim = {
      value: "Тула", sources: [sourceCitation(catalogSource)] }; }],
    ["death place", (value) => { value.people[0].deathPlaceClaim = {
      value: "Казань", sources: [sourceCitation(catalogSource)] }; }],
    ["event", (value) => value.people[0].events![0].sources!.push(sourceCitation(catalogSource))],
    ["union", (value) => { value.unions![0].sources = [sourceCitation(catalogSource)]; }],
    ["formation", (value) => { value.unions![0].formation!.sources = [sourceCitation(catalogSource)]; }],
    ["ending", (value) => { value.unions![0].ending!.sources = [sourceCitation(catalogSource)]; }],
    ["ongoing", (value) => { value.unions![0].ongoing!.sources = [sourceCitation(catalogSource)]; }],
    ["divorce", (value) => { value.unions![1].divorce!.sources = [sourceCitation(catalogSource)]; }],
  ];
  for (const [scope, edit] of cases) {
    const linked = structuredClone(before);
    edit(linked);
    assert.throws(() => authorizeArchive(linked, before, actor("relative")),
      /только администратор/, scope);
    assert.throws(() => authorizeArchive(linked, before, actor("researcher")),
      /только администратор/, scope);
    assert.doesNotThrow(() => authorizeArchive(linked, before, actor("admin")), scope);
    assert.doesNotThrow(() => authorizeArchive(before, linked, actor("relative")),
      `${scope}: existing link can be removed`);
  }
});

test("event citation survives .drevo and GEDCOM as readable evidence without confidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-catalog-"));
  try {
    const uploads = join(directory, "uploads"),
      stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const data = family();
    data.people[0].sources.push(sourceCitation(catalogSource));
    data.people[0].events![0].sources!.push(sourceCitation(catalogSource));
    const packagePath = join(directory, "family.drevo");
    await writePortablePackage(
      createWriteStream(packagePath),
      uploads,
      {
        family: data,
        documents: [],
        comments: [],
        sources: [catalogSource],
      },
      async () => {},
    );
    const portable = await readPortablePackage(packagePath, stage);
    assert.equal(
      portable.snapshot.family.people[0].events?.[0].sources?.[1].catalogId,
      catalogSource.id,
    );
    assert.equal(portable.snapshot.family.people[0].birthDateClaim, undefined);
    assert.equal(portable.snapshot.family.people[0].sources[0].catalogId,
      catalogSource.id);
    for (const version of ["5.5.1", "7.0"] as const) {
      const imported = importGedcom(
        exportGedcom(data, { version }),
        "another-archive",
      );
      const event = imported.family.people[0].events?.find(
        (item) => item.type === "move",
      );
      assert.equal(event?.sources?.[1].title, catalogSource.title);
      assert.equal(event?.sources?.[1].catalogId, undefined);
      assert.equal(imported.family.people[0].sources[0].title, catalogSource.title);
      assert.equal(imported.family.people[0].sources[0].catalogId, undefined);
      assert.equal(imported.family.people[0].birthDateClaim, undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
