import test from "node:test";
import assert from "node:assert/strict";
import { openArchive } from "../src/server/database.ts";
import { allCitations, sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";

const person = (id: string): Person => ({
  id, name: id, surname: "Тестов", patronymic: "", sex: "u", birth: "",
  birthPlace: "", parents: [], spouses: [], generation: 1, column: 0, sources: [],
});

test("Drevo package retains catalog citations of a union milestone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-union-source-"));
  const uploads = join(dir, "uploads");
  await mkdir(uploads);
  const source: CatalogSource = {
    id: "union-record", title: "Акт брака", type: "архив", author: "",
    institution: "", archive: "", fond: "", opis: "", delo: "", sheet: "",
    reference: "", url: "", accessedAt: "", description: "", documentIds: [],
  };
  const snapshot = {
    family: {
      title: "Семья", description: "", demo: false, people: [person("anna"), person("boris")],
      unions: [{ id: "u1", participants: ["anna", "boris"] as [string, string],
        type: "marriage" as const, formation: { sources: [sourceCitation(source)] } }],
    },
    documents: [], comments: [], sources: [source],
  };
  try {
    const path = join(dir, "union.drevo");
    await writePortablePackage(createWriteStream(path), uploads, snapshot, async () => {});
    const stage = join(dir, "stage");
    await mkdir(stage);
    const imported = await readPortablePackage(path, stage);
    assert.equal(imported.snapshot.sources?.[0].id, source.id);
    assert.equal(imported.snapshot.family.unions?.[0].formation?.sources?.[0].catalogId, source.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog links in a union and all four milestones resolve and reject foreign IDs", async () => {
  const archive = await openArchive(":memory:", {
    title: "Пустой архив", description: "", demo: false, people: [],
  });
  const source: CatalogSource = {
    id: "source-union", title: "Акт", type: "запись", author: "", institution: "",
    archive: "", fond: "", opis: "", delo: "", sheet: "", reference: "",
    url: "", accessedAt: "", description: "", documentIds: [],
  };
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const citation = () => sourceCitation(source);
    const family: Family = {
      title: "Семья", description: "", demo: false,
      people: [person("anna"), person("boris")],
      unions: [
        { id: "u1", participants: ["anna", "boris"], type: "marriage",
          sources: [citation()], formation: { sources: [citation()] },
          ending: { sources: [citation()] }, ongoing: { sources: [citation()] } },
        { id: "u2", participants: ["anna", "boris"], type: "marriage",
          divorce: { sources: [citation()] } },
      ],
    };
    await archive.write(family, (await archive.read()).revision);
    assert.equal(allCitations((await archive.read()).family).length, 5);
    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Исправленный акт" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.ok(allCitations((await archive.read()).family)
      .every((item) => item.title === "Исправленный акт"));
    assert.ok(allCitations((await archive.overview()).family)
      .every((item) => item.title === "Исправленный акт"));
    const foreign = structuredClone((await archive.read()).family);
    foreign.unions![1].divorce!.sources![0].catalogId = "foreign-source";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision),
      /Источник отсутствует/);
  } finally {
    await archive.close();
  }
});
