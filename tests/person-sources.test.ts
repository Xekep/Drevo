import assert from "node:assert/strict";
import test from "node:test";
import { collectPersonSources } from "../src/domain/person-sources.ts";
import type { Person } from "../src/domain/types.ts";

function person(): Person {
  return {
    id: "p1",
    surname: "Иванов",
    name: "Иван",
    patronymic: "Иванович",
    sex: "m",
    birth: "1900",
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 0,
    column: 0,
    sources: [
      {
        title: "Архивная запись",
        type: "Архив",
        reference: "Ф. 1, оп. 2",
        url: "https://example.test/archive",
      },
    ],
    awards: [
      {
        id: "a1",
        name: "Медаль «За отвагу»",
        year: "1943",
        source: {
          title: "Наградной лист",
          url: "https://example.test/award",
        },
      },
    ],
    events: [
      {
        id: "e1",
        type: "military",
        title: "Служба",
        sources: [
          {
            title: "Военный документ",
            type: "Архив",
            reference: "Л. 7",
            url: "https://example.test/event",
          },
          {
            title: "Дубль архивной записи",
            type: "Архив",
            reference: "другое описание",
            url: "https://example.test/archive",
          },
        ],
      },
    ],
  };
}

test("collectPersonSources собирает источники карточки, наград и событий", () => {
  const sources = collectPersonSources(person());
  assert.equal(sources.length, 3);
  assert.deepEqual(
    sources.map((source) => source.type),
    ["Архив", "Награда", "Архив"],
  );
  assert.equal(sources[1].reference, "Медаль «За отвагу» · 1943");
  assert.equal(sources[1].origin, "Источник награды");
  assert.equal(sources[2].origin, "Событие: Служба");
});

test("collectPersonSources удаляет дубли по URL", () => {
  const sources = collectPersonSources(person());
  assert.equal(
    sources.filter((source) => source.url === "https://example.test/archive").length,
    1,
  );
});
