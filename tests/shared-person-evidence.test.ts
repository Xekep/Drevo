import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { sharedFamily, type ShareLink } from "../src/domain/shared-family.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { startServer } from "../src/server/index.ts";
import { sharesStore } from "../src/server/shares.ts";
import type { ArchiveUser, Family, Person, Source } from "../src/domain/index.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const source = (title: string, withDocument = false): Source => ({
  title, type: "архив", reference: "л. 7",
  ...(withDocument ? { documentId, documentPage: 3 } : {}),
});
const person = (id: string): Person => ({ id, name: "Анна", surname: "Тестова",
  patronymic: "", sex: "f", birth: "1880", death: "1960",
  birthPlace: "Москва", deathPlace: "Тула", maidenName: "Иванова",
  occupation: "Учитель", parents: [], spouses: [], generation: 1, column: 0,
  sources: [],
  events: [{ id: "move", type: "move", date: "1901", place: "Москва",
    dateClaim: { value: "1901", sources: [source("Дата переезда")] },
    alternatives: [{ id: "other-event-date", field: "date", value: "1902",
      sources: [source("Другая дата переезда", true)], confidence: "conflicting" }] }],
  birthDateClaim: { value: "1880", sources: [source("Дата рождения", true)], confidence: "confirmed" },
  deathDateClaim: { value: "1960", sources: [source("Дата смерти")] },
  birthPlaceClaim: { value: "Москва", sources: [source("Место рождения")] },
  deathPlaceClaim: { value: "Тула", sources: [source("Место смерти")] },
  maidenNameClaim: { value: "Иванова", sources: [source("Фамилия")] },
  occupationClaim: { value: "Учитель", sources: [source("Занятие")] },
  factAlternatives: [
    { id: "other-birth", field: "birth", value: "1881",
      sources: [source("Другая дата", true)], confidence: "probable" },
    { id: "other-place", field: "birthPlace", value: "Рязань",
      sources: [source("Другое место")] },
  ],
});
const family = (withDocuments = false): Family => {
  const visible = person("visible"), hidden = person("hidden");
  hidden.sources = [source("Скрытая запись")];
  hidden.factAlternatives![0].sources = [source("Скрытый вариант")];
  if (!withDocuments) {
    delete visible.birthDateClaim!.sources[0].documentId;
    delete visible.birthDateClaim!.sources[0].documentPage;
    delete visible.factAlternatives![0].sources[0].documentId;
    delete visible.factAlternatives![0].sources[0].documentPage;
    delete visible.events![0].alternatives![0].sources[0].documentId;
    delete visible.events![0].alternatives![0].sources[0].documentPage;
  }
  return { title: "Архив", description: "Частное описание", demo: false,
    people: [visible, hidden] };
};
const share: ShareLink = { id: "share", title: "Фрагмент", anchorId: "visible",
  personIds: ["visible"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
  createdBy: "owner", createdName: "Владелец", revokedAt: null,
  lastVisitedAt: null };

test("public projection retains exact person evidence while hiding documents and other people", () => {
  const original = family(true);
  const projected = sharedFamily(original, share, "token");
  assert.deepEqual(projected.people.map((item) => item.id), ["visible"]);
  assert.equal(projected.description, "");
  assert.equal(projected.people[0].birthDateClaim?.confidence, "confirmed");
  assert.equal(projected.people[0].birthDateClaim?.sources[0].title, "Дата рождения");
  assert.equal(projected.people[0].factAlternatives?.[0].value, "1881");
  assert.equal(projected.people[0].factAlternatives?.[0].sources[0].title, "Другая дата");
  assert.equal(projected.people[0].events?.[0].dateClaim?.sources[0].title, "Дата переезда");
  assert.equal(projected.people[0].events?.[0].alternatives?.[0].value, "1902");
  assert.equal(projected.people[0].events?.[0].alternatives?.[0].confidence, "conflicting");
  assert.equal(projected.people[0].events?.[0].alternatives?.[0].sources[0].title,
    "Другая дата переезда");
  for (const key of ["deathDateClaim", "birthPlaceClaim", "deathPlaceClaim",
    "maidenNameClaim", "occupationClaim"] as const)
    assert.equal(projected.people[0][key]?.sources.length, 1);
  assert.ok(!JSON.stringify(projected).includes(documentId));
  assert.ok(!JSON.stringify(projected).includes("Скрыт"));
  assert.equal(original.people[0].factAlternatives?.[0].sources[0].documentId, documentId);
  assert.equal(original.people[0].events?.[0].alternatives?.[0].sources[0].documentId, documentId);
  assert.doesNotThrow(() => validateFamily(projected));
});

test("person evidence remains attributed after GEDCOM transfer into a shared fragment", () => {
  const original = family();
  for (const version of ["5.5.1", "7.0"] as const) {
    const transferred = importGedcom(exportGedcom(original, { version }),
      `shared-evidence-${version}`).family;
    const selected = transferred.people[0];
    const projected = sharedFamily(transferred, { ...share, anchorId: selected.id,
      personIds: [selected.id] }, "token");
    assert.equal(projected.people[0].birthDateClaim?.sources[0].title, "Дата рождения");
    assert.equal(projected.people[0].factAlternatives?.[0].value, "1881");
    assert.equal(projected.people[0].factAlternatives?.[0].sources[0].title, "Другая дата");
    assert.equal(projected.people[0].birth, "1880");
  }
});

test("guest HTTP share exposes only selected person's evidence until revoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-shared-person-evidence-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  try {
    const original = family();
    await app.archive.write(original, (await app.archive.read()).revision);
    const actor: ArchiveUser = { id: "owner", name: "Владелец", role: "admin",
      createdAt: "2026-01-01" };
    const shares = sharesStore(app.archive.db);
    const issued = await shares.create({ title: "Фрагмент", anchorId: "visible",
      personIds: ["visible"], durationHours: 1 }, original, actor);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const response = await fetch(`${base}/api/shared/${issued.token}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.family.people.length, 1);
    assert.equal(body.family.people[0].birthDateClaim.sources[0].title, "Дата рождения");
    assert.equal(body.family.people[0].factAlternatives[0].value, "1881");
    assert.ok(!JSON.stringify(body).includes("Скрытая запись"));
    await shares.revoke(issued.share.id, actor);
    assert.equal((await fetch(`${base}/api/shared/${issued.token}`)).status, 410);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
