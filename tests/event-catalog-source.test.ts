import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
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
  edited.people[0].events![0].sources!.pop();
  assert.equal(
    authorizeArchive(edited, linked, actor("relative")).people[0].events?.[0]
      .sources?.length,
    1,
  );
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
