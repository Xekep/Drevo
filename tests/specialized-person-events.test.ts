import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { migrateLegacyEducationEvent, retypeEvent, validateEvents } from "../src/domain/person-events.ts";
import type { Family, PersonEvent } from "../src/domain/types.ts";
import { validateFamily } from "../src/domain/validation.ts";

test("legacy labelled education notes migrate to a field without losing other notes", () => {
  const old: PersonEvent = { id: "study", type: "education", title: "Техникум",
    description: "Направление подготовки: Электротехника\nУчился на вечернем отделении",
    sources: [{ title: "Диплом", type: "", reference: "л. 1" }] };
  const migrated = migrateLegacyEducationEvent(old);
  assert.equal(migrated.educationField, "Электротехника");
  assert.equal(migrated.description, "Учился на вечернем отделении");
  assert.deepEqual(migrated.sources, old.sources);
  assert.equal(old.educationField, undefined, "migration must not mutate old records");
  assert.deepEqual(migrateLegacyEducationEvent(migrated), migrated);
});

test("unlabelled notes remain untouched rather than guessed into a specialty", () => {
  const event: PersonEvent = { id: "school", type: "education", description: "Математика и физика" };
  assert.equal(migrateLegacyEducationEvent(event), event);
  const detailed: PersonEvent = { ...event, description: "Специальность: Физика\nУчебная лаборатория" };
  assert.deepEqual(migrateLegacyEducationEvent(detailed), {
    ...detailed, educationField: "Физика", description: "Учебная лаборатория",
  });
});

test("new fields are type-checked and are cleared on a type change", () => {
  const education: PersonEvent = { id: "study", type: "education", title: "Университет",
    educationField: "Программная инженерия", educationQualification: "Бакалавр",
    educationStatus: "completed", description: "Заочное обучение" };
  assert.doesNotThrow(() => validateEvents([education]));
  assert.throws(() => validateEvents([{ ...education, educationStatus: "unknown" }]),
    /дополнительные поля/);
  assert.throws(() => validateEvents([{ ...education, type: "work" }]),
    /дополнительные поля/);
  assert.throws(() => validateEvents([{ ...education, educationField: "a".repeat(1001) }]),
    /описание события/);
  const next = retypeEvent(education, "work").event;
  assert.equal(next.educationField, undefined);
  assert.equal(next.educationQualification, undefined);
  assert.equal(next.educationStatus, undefined);
  assert.equal(next.description, "Заочное обучение", "historical notes are not discarded");
  const work: PersonEvent = { id: "job", type: "work", organization: "Завод", position: "Инженер" };
  const military: PersonEvent = { id: "army", type: "military", militaryUnit: "544-й сп",
    militaryRank: "красноармеец" };
  const move: PersonEvent = { id: "move", type: "move", moveFrom: "Екатеринбург", place: "Москва" };
  assert.doesNotThrow(() => validateEvents([work, military, move]));
});

for (const version of ["5.5.1", "7.0"] as const)
  test(`GEDCOM ${version} preserves education, military and work fields, notes and sources`, () => {
    const events: PersonEvent[] = [
      { id: "study", type: "education", title: "Университет", date: "1990",
        endDate: "1995", educationField: "Прикладная математика",
        educationQualification: "Инженер", educationStatus: "completed",
        description: "Вечернее отделение",
        sources: [{ title: "Диплом", type: "документ", reference: "15",
          url: "https://example.org/diploma" }] },
      { id: "job", type: "work", date: "1996", organization: "НПО",
        position: "Инженер-технолог" },
      { id: "army", type: "military", date: "1942", militaryUnit: "544-й полк",
        militaryRank: "красноармеец" },
      { id: "move", type: "move", date: "1960", moveFrom: "Пермь", place: "Москва" },
    ];
    const family: Family = { title: "Семья", description: "", demo: false,
      people: [{ id: "person", name: "Иван", surname: "Иванов", patronymic: "",
        sex: "m", birth: "1920", birthPlace: "", parents: [], spouses: [],
        generation: 1, column: 0, sources: [], events }] };
    validateFamily(family);
    const encoded = exportGedcom(family, { version });
    assert.match(encoded, /_DREVO_EVENT_DETAILS/);
    const restored = importGedcom(encoded, `special-${version}`).family.people[0].events || [];
    const study = restored.find((event) => event.type === "education");
    assert.equal(study?.educationField, "Прикладная математика");
    assert.equal(study?.educationQualification, "Инженер");
    assert.equal(study?.educationStatus, "completed");
    assert.equal(study?.description, "Вечернее отделение");
    assert.equal(study?.sources?.[0].url, "https://example.org/diploma");
    assert.equal(restored.find((event) => event.type === "work")?.organization, "НПО");
    assert.equal(restored.find((event) => event.type === "military")?.militaryUnit, "544-й полк");
    assert.equal(restored.find((event) => event.type === "move")?.moveFrom, "Пермь");
  });
