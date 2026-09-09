import type { Family } from "./types.ts";

/** Явный список полей: фотографии и служебные данные не попадают в выгрузку. */
export function analysisExport(
  family: Family,
  revision: number,
  exportedAt: string,
) {
  return {
    format: "drevo.genealogy",
    version: 1,
    exportedAt,
    revision,
    title: family.title,
    description: family.description,
    semantics: {
      parents:
        "Идентификаторы известных биологических родителей человека. Пустой список означает отсутствие сведений.",
      spouses:
        "Идентификаторы супругов, включая прежние браки. Порядок не означает очередность браков.",
      links:
        "Дополнительные связи: from выполняет указанную роль по отношению к to. Братья/сёстры и названое братство симметричны; порядок участников не задаёт старшинство. Прямая запись братьев/сестёр не создаёт карточки общих родителей.",
      linkTypes: {
        sibling: "кровные брат / сестра, полнородность не уточнена",
        full_sibling: "полнородные брат / сестра, общие отец и мать",
        paternal_sibling:
          "единокровные брат / сестра, общий отец и разные матери",
        maternal_sibling:
          "единоутробные брат / сестра, общая мать и разные отцы",
        step_sibling: "сводные брат / сестра, общих кровных родителей нет",
        adoptive_parent: "приёмный родитель",
        godparent: "крёстный родитель",
        nurse: "кормилица",
        sworn_sibling: "побратим / посестра",
        guardian: "опекун",
      },
      dates:
        "ГГГГ, ГГГГ-ММ или ГГГГ-ММ-ДД; пустая строка — неизвестно. Отсутствие даты смерти не подтверждает, что человек жив.",
      places:
        "Названия сохранены в формулировке автора; координаты присутствуют только при явном уточнении места.",
    },
    people: family.people.map((p) => ({
      id: p.id,
      surname: p.surname,
      name: p.name,
      patronymic: p.patronymic,
      sex: p.sex,
      birth: p.birth,
      death: p.death,
      birthPlace: p.birthPlace,
      deathPlace: p.deathPlace,
      birthLocation: p.birthLocation,
      deathLocation: p.deathLocation,
      maidenName: p.maidenName,
      occupation: p.occupation,
      biography: p.biography,
      awards: p.awards?.map((a) => ({
        id: a.id,
        name: a.name,
        year: a.year,
        source: a.source
          ? { title: a.source.title, url: a.source.url }
          : undefined,
      })),
      parents: [...p.parents],
      parentageComplete: p.parentageComplete,
      spouses: [...p.spouses],
      sources: p.sources.map((s) => ({
        title: s.title,
        type: s.type,
        reference: s.reference,
        url: s.url,
        note: s.note,
      })),
    })),
    links: (family.links || []).map((l) => ({
      id: l.id,
      from: l.from,
      to: l.to,
      type: l.type,
      note: l.note,
    })),
  };
}
