import assert from "node:assert/strict";
import test from "node:test";
import { generationReport } from "../src/domain/generation-report.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import type { ArchiveUser, Family, Person, Source } from "../src/domain/index.ts";

const person = (id: string, parents: string[] = []): Person => ({
  id, name: id, surname: "", patronymic: "", sex: "u", birth: "",
  birthPlace: "", parents, spouses: [], generation: 0, column: 0, sources: [],
});
const citation = (title: string, page: number): Source => ({
  title, type: "архив", reference: `л. ${page}`,
  url: `https://example.test/record?page=${page}`,
  documentId: `private-file-${page}`, documentPage: page,
});
const evidence = (): Family => {
  const father = person("Отец");
  father.sex = "m";
  const mother = person("Мать");
  mother.sex = "f";
  const child = person("Ребёнок", [father.id, mother.id]);
  child.parentClaims = [
    { parentId: father.id, confidence: "probable", sources: [
      citation("Метрическая запись", 2), citation("Перепись", 7),
      citation("Метрическая запись", 2),
    ] },
    { parentId: mother.id, confidence: "conflicting", sources: [citation("Письмо", 4)] },
  ];
  return { title: "Тест", description: "", demo: false, people: [father, mother, child] };
};

test("generation register attributes each visible parent assessment and citation to its edge", () => {
  const data = evidence();
  const text = generationReport(data, new Set(data.people.map((item) => item.id)));
  assert.match(text, /Отец: №\d+ Отец[\s\S]*Оценка родительства.*Вероятно/);
  assert.match(text, /Мать: №\d+ Мать[\s\S]*Оценка родительства.*Противоречиво/);
  assert.match(text, /Метрическая запись; архив; л\. 2; https:\/\/example\.test\/record\?page=2/);
  assert.match(text, /Перепись; архив; л\. 7; https:\/\/example\.test\/record\?page=7/);
  assert.equal(text.match(/Метрическая запись; архив; л\. 2/g)?.length, 1);
  assert.doesNotMatch(text, /private-file-|documentPage/);
  assert.doesNotMatch(generationReport(data, new Set(["Ребёнок"])),
    /Отец|Мать|Метрическая запись|Перепись|Письмо|Вероятно|Противоречиво/);
});

test("legacy and shared projections cannot disclose evidence of an omitted parent edge", () => {
  const data = evidence();
  const legacy = structuredClone(data);
  delete legacy.people[2].parentClaims;
  assert.match(generationReport(legacy, new Set(legacy.people.map((item) => item.id))),
    /Отец: №\d+ Отец/);
  assert.doesNotMatch(generationReport(legacy, new Set(legacy.people.map(item => item.id))),
    /Источник родительства|Оценка родительства/);
  const shared = sharedFamily(data, {
    id: "share", title: "Branch", anchorId: "Ребёнок", personIds: ["Ребёнок"],
    createdAt: "", expiresAt: "", createdBy: "owner", createdName: "Owner",
    revokedAt: null, lastVisitedAt: null,
  }, "token");
  assert.doesNotMatch(generationReport(shared, new Set(["Ребёнок"])),
    /Отец|Мать|Метрическая запись|Перепись|Письмо|Вероятно|Противоречиво/);
  const scoped = structuredClone(data);
  scoped.people[0].createdBy = "other";
  scoped.people[1].createdBy = "other";
  scoped.people[2].createdBy = "editor";
  scoped.people.push(person("Сосед"));
  const actor = { id: "editor", name: "Editor", role: "researcher", approved: true,
    createdAt: "2026-01-01", treeAccess: "common_ancestors", personId: "Сосед" } as ArchiveUser;
  const visible = projectFamilyForUser(scoped, actor);
  assert.deepEqual(visible.people.find((item) => item.id === "Ребёнок")?.parents, []);
  assert.doesNotMatch(generationReport(visible, new Set(visible.people.map(item => item.id))),
    /Отец|Мать|Метрическая запись|Перепись|Письмо|Вероятно|Противоречиво/);
});
