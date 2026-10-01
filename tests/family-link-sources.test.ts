import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveConnections, replaceConnection } from "../src/domain/connections.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { openArchive } from "../src/server/database.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { allCitations, sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";

const person = (id: string): Person => ({ id, name: id, surname: "Тестов",
  patronymic: "", sex: "u", birth: "", birthPlace: "", parents: [], spouses: [],
  generation: 1, column: 0, sources: [], createdBy: "owner" });
const source: CatalogSource = { id: "guardian-record", title: "Дело об опеке", type: "архив",
  author: "", institution: "", archive: "", fond: "", opis: "", delo: "", sheet: "",
  reference: "л. 3", url: "", accessedAt: "", description: "", documentIds: [] };
const family = (): Family => ({ title: "Семья", description: "", demo: false,
  people: [person("adult"), person("child"), person("other")],
  links: [{ id: "care", from: "adult", to: "child", type: "presumed_parent",
    createdBy: "owner", sources: [{ title: "Семейная запись", type: "рукопись",
      reference: "л. 2" }] }] });
const actor = (role: ArchiveUser["role"]): ArchiveUser => ({ id: "owner",
  name: "Владелец", role, createdAt: "2026-01-01" });

test("a link citation stays on its assertion and catalog access is checked on the server", () => {
  const before = family();
  const linked = structuredClone(before);
  linked.links![0].sources!.push(sourceCitation(source));
  assert.throws(() => authorizeArchive(linked, before, actor("relative")),
    /только администратор/);
  assert.throws(() => authorizeArchive(linked, before, actor("researcher")),
    /только администратор/);
  assert.equal(authorizeArchive(linked, before, actor("admin")).links?.[0].sources?.length, 2);
  const inline = structuredClone(before);
  inline.links![0].sources![0].reference = "л. 4";
  assert.equal(authorizeArchive(inline, before, actor("relative")).links?.[0].sources?.[0].reference,
    "л. 4");
  const note = structuredClone(linked);
  note.links![0].note = "Проверить";
  assert.equal(authorizeArchive(note, linked, actor("relative")).links?.[0].sources?.length, 2);
  for (const field of ["from", "to", "type"] as const) {
    const changed = structuredClone(linked);
    if (field === "from") changed.links![0].from = "other";
    if (field === "to") changed.links![0].to = "other";
    if (field === "type") changed.links![0].type = "guardian";
    for (const role of ["relative", "admin"] as const)
      assert.throws(() => authorizeArchive(changed, linked, actor(role)),
        /снимите прежние источники/, `${role} cannot carry citations to a new assertion`);
    changed.links![0].sources = [];
    assert.doesNotThrow(() => authorizeArchive(changed, linked, actor("admin")));
  }
  const duplicate = structuredClone(linked);
  duplicate.links![0].sources!.push(sourceCitation(source));
  assert.throws(() => authorizeArchive(duplicate, linked, actor("relative")),
    /только администратор/);
  const forged = structuredClone(linked);
  forged.links![0].sources![1].title = "Подмена";
  assert.throws(() => authorizeArchive(forged, linked, actor("relative")),
    /Изменить каталожную цитату/);
  const removed = structuredClone(linked);
  removed.links![0].sources!.pop();
  assert.doesNotThrow(() => authorizeArchive(removed, linked, actor("relative")));
  const original = archiveConnections(linked).find((edge) => edge.id === "care")!;
  const edited = replaceConnection(linked, original, { ...original, note: "Новая запись" });
  assert.equal(edited.links?.[0].sources?.length, 2);
  const moved = replaceConnection(linked, original, { ...original, to: "other" });
  assert.equal(moved.links?.[0].sources, undefined);
  assert.deepEqual(moved.people.find((entry) => entry.id === "other")?.parents, [],
    "presumed parentage does not become biological parentage");
});

test("SQLite, .drevo and GEDCOM retain link evidence without foreign catalog IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-link-source-"));
  const archive = await openArchive(join(dir, "archive.sqlite"), family());
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const linked = structuredClone((await archive.read()).family);
    linked.links![0].sources!.push(sourceCitation(source));
    await archive.write(linked, (await archive.read()).revision);
    assert.equal((await archive.read()).family.links?.[0].sources?.[1].catalogId, source.id);
    assert.equal(allCitations((await archive.read()).family).length, 2);
    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Уточнённое дело" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.links?.[0].sources?.[1].title, "Уточнённое дело");
    const foreign = structuredClone((await archive.read()).family);
    foreign.links![0].sources![1].catalogId = "foreign-source";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision),
      /Источник отсутствует/);
    const snapshot = { family: (await archive.read()).family, documents: [], comments: [],
      sources: [{ ...source, title: "Уточнённое дело" }] };
    const uploads = join(dir, "uploads");
    await mkdir(uploads);
    const path = join(dir, "links.drevo");
    await writePortablePackage(createWriteStream(path), uploads, snapshot, async () => {});
    const stage = join(dir, "stage");
    await mkdir(stage);
    const portable = await readPortablePackage(path, stage);
    assert.equal(portable.snapshot.family.links?.[0].sources?.[1].catalogId, source.id);
    const gedcom = exportGedcom(snapshot.family, { version: "7.0" });
    assert.match(gedcom, /1 ASSO @I\d+@\r\n2 ROLE OTHER[\s\S]*?2 SOUR @S\d+@/);
    const imported = importGedcom(gedcom, "link-source").family;
    assert.equal(imported.links?.[0].sources?.length, 2);
    assert.equal(imported.links?.[0].sources?.[1].title, "Уточнённое дело");
    assert.equal(imported.links?.[0].sources?.[1].catalogId, undefined);
    assert.deepEqual(imported.people.find((entry) => entry.name === "child")?.parents, []);
    const legacy = importGedcom(exportGedcom(snapshot.family, { version: "5.5.1" }),
      "link-source-551").family;
    assert.equal(legacy.links?.[0].sources?.[1].title, "Уточнённое дело");
    assert.equal(legacy.links?.[0].sources?.[1].catalogId, undefined);
    const withoutSources = structuredClone(snapshot.family);
    delete withoutSources.links?.[0].sources;
    assert.equal(importGedcom(exportGedcom(withoutSources, { version: "7.0" }),
      "old-link").family.links?.[0].sources, undefined);
  } finally {
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});
