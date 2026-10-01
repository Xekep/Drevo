import { SaxesParser } from "saxes";
import type {
  Family,
  Person,
  PersonEvent,
  PlaceLocation,
  Source,
} from "./types.ts";
import { validDate } from "./dates.ts";
import { validateFamily } from "./validation.ts";
import {
  TRANSFER_XML_LIMIT,
  type GenealogyImport,
  type TransferMedia,
} from "./genealogy-transfer.ts";

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};
const one = (node: XmlNode, name: string) =>
  node.children.find((c) => c.name === name);
const many = (node: XmlNode | undefined, name: string) =>
  node?.children.filter((c) => c.name === name) || [];
const textOf = (node: XmlNode, name: string) => one(node, name)?.text || "";

function extraAttributes(
  node: XmlNode,
  known: string[],
  context: string,
  warnings: Set<string>,
): string[] {
  return Object.entries(node.attrs)
    .filter(([key, value]) => !known.includes(key) && value.trim())
    .map(([key, value]) => {
      warnings.add(
        `Поле ${context}.${key} сохранено как текст; его тип и назначение в Drevo не представлены.`,
      );
      return `${key}: ${value}`;
    });
}

function addNotes(
  current: string | undefined,
  notes: string[],
): string | undefined {
  return [current, ...notes].filter(Boolean).join("\n") || undefined;
}

function extraChildren(
  node: XmlNode,
  known: string[],
  context: string,
  warnings: Set<string>,
): string[] {
  const lines: string[] = [];
  const visit = (child: XmlNode, path: string) => {
    if (
      !Object.keys(child.attrs).length &&
      !child.text.trim() &&
      !child.children.length
    )
      lines.push(`${path}: (пустое значение)`);
    for (const [key, value] of Object.entries(child.attrs))
      lines.push(`${path}.${key}: ${value}`);
    if (child.text.trim()) lines.push(`${path}: ${child.text.trim()}`);
    for (const nested of child.children)
      visit(nested, `${path}.${nested.name}`);
  };
  for (const child of node.children.filter(
    (item) => !known.includes(item.name),
  )) {
    warnings.add(
      `Раздел ${context}.${child.name} сохранён как текст без исходной структуры.`,
    );
    visit(child, `${context}.${child.name}`);
  }
  return lines;
}

function parseXml(text: string): XmlNode {
  if (new TextEncoder().encode(text).length > TRANSFER_XML_LIMIT)
    throw new Error("XML больше 256 МиБ");
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    count = 0;
  parser.on("doctype", () => {
    throw new Error("DTD и внешние сущности в XML запрещены");
  });
  parser.on("opentag", (tag) => {
    if (++count > 500000 || stack.length > 50)
      throw new Error("Слишком сложная структура XML");
    const node: XmlNode = {
      name: tag.name,
      attrs: tag.attributes,
      text: "",
      children: [],
    };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    stack.push(node);
  });
  const addText = (value: string) => {
    if (stack.length) stack[stack.length - 1].text += value;
  };
  parser.on("text", addText);
  parser.on("cdata", addText);
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(text).close();
  if (!root || root.name !== "agelongtree")
    throw new Error("Ожидается XML с корнем agelongtree из «Древа Жизни»");
  return root;
}

function xmlDate(raw = ""): string | undefined {
  if (/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(raw) && validDate(raw)) return raw;
  const match = /^(?:(\d{1,2})\.)?(\d{1,2})\.(\d{4})$/.exec(raw);
  if (!match) return undefined;
  const date = `${match[3]}-${match[2].padStart(2, "0")}${match[1] ? `-${match[1].padStart(2, "0")}` : ""}`;
  return validDate(date) ? date : undefined;
}
const eventTypes: Record<string, PersonEvent["type"]> = {
  Свадьба: "marriage",
  Marriage: "marriage",
  Развод: "divorce",
  Divorce: "divorce",
  "Место жительства": "residence",
  Проживание: "residence",
  Residence: "residence",
  Переезд: "move",
  Образование: "education",
  Работа: "work",
  Occupation: "work",
  "Военная служба": "military",
  Крещение: "baptism",
  Baptism: "baptism",
  Погребение: "burial",
  Burial: "burial",
};
const birthRoles = new Set(["Родился", "Родилась", "Born", "Child"]);
const deathRoles = new Set(["Умер", "Умерла", "Died", "Deceased"]);
const parentRoles = new Set(["Отец", "Мать", "Father", "Mother"]);
const spouseRoles = new Set([
  "Муж",
  "Жена",
  "Husband",
  "Wife",
  "Жених",
  "Невеста",
  "Groom",
  "Bride",
]);

export function importAgelongXml(
  text: string,
  namespace: string,
): GenealogyImport {
  const root = parseXml(text),
    warnings = new Set<string>();
  const nodes = many(one(root, "persons"), "person");
  if (!nodes.length || nodes.length > 10000)
    throw new Error("В XML должно быть от 1 до 10 000 людей");
  const index = (items: XmlNode[]) => {
    const map = new Map<string, XmlNode>();
    for (const item of items) {
      if (!item.attrs.id || map.has(item.attrs.id))
        throw new Error("Отсутствует или повторяется ID XML");
      map.set(item.attrs.id, item);
    }
    return map;
  };
  index(nodes);
  const ids = new Map(
    nodes.map((n, i) => [n.attrs.id, `${namespace}-p${i + 1}`]),
  );
  const places = index(many(one(root, "places"), "place"));
  const families = index(many(one(root, "families"), "family"));
  const sourceNodes = index(many(one(root, "sources"), "source"));
  const usedSources = new Set<string>();
  const sourcesFor = (node: XmlNode, context: string): Source[] =>
    many(one(node, "sources"), "source").flatMap((ref) => {
      const source = sourceNodes.get(ref.attrs.id);
      if (!source) {
        warnings.add(
          `Источник ${ref.attrs.id || "без ID"} для ${context} отсутствует в XML; ссылка не перенесена.`,
        );
        return [];
      }
      usedSources.add(ref.attrs.id);
      const a = source.attrs;
      const title =
        a.title ||
        a.name ||
        a.fullname ||
        textOf(source, "title") ||
        `Источник ${a.id}`;
      const details = [
        ...extraAttributes(
          source,
          ["id", "title", "name", "fullname", "type", "reference", "url"],
          "source",
          warnings,
        ),
        ...extraChildren(source, ["title", "comment"], "source", warnings),
        ...extraAttributes(ref, ["id"], "source-link", warnings),
        ref.text.trim() && `Ссылка: ${ref.text.trim()}`,
      ].filter(Boolean) as string[];
      return [
        {
          title,
          type: a.type || "",
          reference: a.reference || "",
          url: a.url || undefined,
          note: addNotes(textOf(source, "comment") || undefined, details),
        },
      ];
    });
  const coordinates = (
    raw: string | undefined,
    name: string,
    label: string,
  ): PlaceLocation | undefined => {
    if (!raw) return undefined;
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
    const lat = match && Number(match[1]),
      lon = match && Number(match[2]);
    if (
      !name ||
      lat === null ||
      lon === null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      warnings.add(
        `Координаты ${label} не перенесены: нет названия места или значения вне допустимого диапазона.`,
      );
      return undefined;
    }
    return { place: name, lat, lon };
  };
  const placeDetails = (node: XmlNode, tag = "place") => {
    const ref = one(node, tag);
    const placeNode = ref && places.get(ref.attrs.id);
    const name = (ref?.text || placeNode?.attrs.fullname || "").trim();
    return {
      name,
      location: coordinates(
        (node.name === "event" && node.attrs.coords) || placeNode?.attrs.coords,
        name,
        tag === "place" ? "события или проживания" : tag,
      ),
    };
  };
  const uncertain = (
    raw: string | undefined,
    label: string,
    id: string,
  ): PersonEvent[] =>
    raw && !xmlDate(raw)
      ? [
          {
            id,
            type: "other",
            gedcomTag: label === "Рождение" ? "BIRT" : "DEAT",
            title: label,
            dateText: raw,
          },
        ]
      : [];
  const people: Person[] = nodes.map((n, i) => {
    const a = n.attrs;
    const birthPlace = placeDetails(n, "bplace"),
      deathPlace = placeDetails(n, "dplace"),
      residence = placeDetails(n);
    if (!a.fn || !a.sn)
      warnings.add("Отсутствующие имя и фамилия помечены как неизвестные.");
    const p: Person = {
      id: ids.get(a.id)!,
      name: a.fn || "Имя неизвестно",
      surname: a.sn || "Фамилия неизвестна",
      patronymic: a.mn || "",
      maidenName: a.msn || undefined,
      sex: ["М", "M", "m"].includes(a.sex)
        ? "m"
        : ["Ж", "F", "f"].includes(a.sex)
          ? "f"
          : "u",
      birth: xmlDate(a.bdate) || "",
      death: xmlDate(a.ddate),
      deceased: a.ddate ? true : undefined,
      birthPlace: birthPlace.name,
      birthLocation: birthPlace.location,
      deathPlace: deathPlace.name || undefined,
      deathLocation: deathPlace.location,
      occupation: a.occu || undefined,
      biography: textOf(n, "comment") || undefined,
      sources: sourcesFor(n, `person ${a.id}`),
      parents: [],
      spouses: [],
      generation: 1,
      column: 0,
      events: [
        ...uncertain(a.bdate, "Рождение", `${namespace}-b${i}`),
        ...uncertain(a.ddate, "Уход из жизни", `${namespace}-d${i}`),
      ],
    };
    if (a.dreason)
      p.biography = [p.biography, `Причина смерти: ${a.dreason}`]
        .filter(Boolean)
        .join("\n");
    if (a.fav) {
      p.biography = addNotes(p.biography, [
        `Флаг избранного в «Древе Жизни»: ${a.fav}`,
      ]);
      warnings.add(
        "Флаг избранного сохранён в биографии; отдельного признака избранного в Drevo нет.",
      );
    }
    const familyRef = one(n, "family");
    if (familyRef) {
      const group = families.get(familyRef.attrs.id);
      if (group?.attrs.name) {
        p.biography = addNotes(p.biography, [
          `Род в «Древе Жизни»: ${group.attrs.name}`,
        ]);
        warnings.add(
          "Названия родов сохранены в биографиях участников; отдельной модели родов в Drevo нет.",
        );
      } else if (!group) {
        warnings.add(
          `Род ${familyRef.attrs.id} отсутствует в XML; ссылка не перенесена.`,
        );
      }
    }
    if (residence.name)
      p.events!.push({
        id: `${namespace}-r${i}`,
        type: "residence",
        place: residence.name,
        location: residence.location,
      });
    const extra = textOf(n, "drevo");
    if (extra) {
      const data = JSON.parse(extra);
      for (const key of [
        "name",
        "surname",
        "patronymic",
        "maidenName",
        "birth",
        "death",
        "deceased",
        "birthPlace",
        "deathPlace",
        "birthLocation",
        "deathLocation",
        "occupation",
        "biography",
        "events",
        "sources",
        "awards",
        "parentageComplete",
      ] as const)
        if (Object.hasOwn(data, key)) Object.assign(p, { [key]: data[key] });
    }
    const known = [
      "id",
      "sex",
      "fullname",
      "sn",
      "fn",
      "mn",
      "msn",
      "occu",
      "bdate",
      "ddate",
      "dreason",
      "lifespan",
      "fav",
    ];
    p.biography = addNotes(p.biography, [
      ...extraAttributes(n, known, "person", warnings),
      ...extraChildren(
        n,
        [
          "family",
          "nearest",
          "events",
          "documents",
          "place",
          "bplace",
          "dplace",
          "comment",
          "drevo",
          "sources",
        ],
        "person",
        warnings,
      ),
    ]);
    return p;
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  const resolvePerson = (id: string) => {
    const p = byId.get(ids.get(id) || "");
    if (!p) throw new Error(`Не найден участник XML: ${id}`);
    return p;
  };
  const events = index(many(one(root, "events"), "event"));
  for (const [eventId, n] of events) {
    const extraEvent = [
      ...extraAttributes(
        n,
        [
          "id",
          "type",
          "date",
          "passed",
          "daysleft",
          "coords",
          "institution",
          "deathreason",
        ],
        "event",
        warnings,
      ),
      ...extraChildren(
        n,
        ["place", "comment", "persons", "documents", "sources"],
        "event",
        warnings,
      ),
    ];
    const eventSources = sourcesFor(n, `event ${eventId}`);
    const participants = many(one(n, "persons"), "person").map((ref) => ({
      person: resolvePerson(ref.attrs.id),
      role: ref.attrs.role,
    }));
    const birth = ["Рождение", "Birth"].includes(n.attrs.type);
    const death = ["Смерть", "Death", "Уход из жизни"].includes(n.attrs.type);
    const type = eventTypes[n.attrs.type] || "other";
    if (birth) {
      const parents = participants
        .filter((v) => parentRoles.has(v.role))
        .map((v) => v.person.id);
      for (const target of participants.filter((v) => birthRoles.has(v.role)))
        target.person.parents = [
          ...new Set([...target.person.parents, ...parents]),
        ];
    }
    if (type === "marriage" || type === "divorce") {
      const pair = participants
        .filter((v) => spouseRoles.has(v.role))
        .map((v) => v.person);
      if (pair.length === 2)
        for (const p of pair)
          p.spouses = [
            ...new Set([
              ...p.spouses,
              ...pair.filter((s) => s !== p).map((s) => s.id),
            ]),
          ];
    }
    for (const { person: p, role } of participants) {
      if ((birth && !birthRoles.has(role)) || (death && !deathRoles.has(role)))
        continue;
      const raw = n.attrs.date || "",
        date = xmlDate(raw),
        place = placeDetails(n),
        description = [
          textOf(n, "comment"),
          n.attrs.institution && `Учреждение: ${n.attrs.institution}`,
          n.attrs.deathreason &&
            !p.biography?.includes(`Причина смерти: ${n.attrs.deathreason}`) &&
            `Причина смерти: ${n.attrs.deathreason}`,
          ...extraEvent,
        ]
          .filter(Boolean)
          .join("\n");
      if (birth || death) {
        if (eventSources.length) {
          p.sources.push(
            ...eventSources.map((source) => ({
              ...source,
              note: addNotes(source.note, [`Событие: ${n.attrs.type}`]),
            })),
          );
          warnings.add(
            "Источники рождения и смерти прикреплены к карточкам людей с пометкой события.",
          );
        }
        if (date) {
          if (birth && !p.birth) p.birth = date;
          if (death && !p.death) p.death = date;
        }
        if (death) p.deceased = true;
        if (place.name) {
          if (birth && !p.birthPlace) p.birthPlace = place.name;
          if (death && !p.deathPlace) p.deathPlace = place.name;
        }
        if (birth && place.location && !p.birthLocation)
          p.birthLocation = place.location;
        if (death && place.location && !p.deathLocation)
          p.deathLocation = place.location;
        if (
          raw &&
          !date &&
          !p.events?.some(
            (e) =>
              e.dateText === raw &&
              e.title === (birth ? "Рождение" : "Уход из жизни"),
          )
        )
          (p.events ||= []).push(
            ...uncertain(
              raw,
              birth ? "Рождение" : "Уход из жизни",
              `${namespace}-e${eventId}`,
            ),
          );
        if (description)
          p.biography = [
            ...new Set([p.biography, description].filter(Boolean)),
          ].join("\n\n");
      } else if (
        !textOf(
          nodes.find((node) => ids.get(node.attrs.id) === p.id)!,
          "drevo",
        )
      ) {
        (p.events ||= []).push({
          id: `${namespace}-e${eventId}`,
          type,
          title: n.attrs.type,
          date,
          dateText: !date && raw ? raw : undefined,
          place: place.name || undefined,
          location: place.location,
          description: description || undefined,
          sources: eventSources.length
            ? eventSources.map((source) => ({ ...source }))
            : undefined,
        });
      }
    }
  }
  for (const n of nodes)
    for (const ref of many(one(n, "events"), "event"))
      if (!events.has(ref.attrs.id))
        warnings.add(
          `Событие ${ref.attrs.id} отсутствует в XML; ссылка не перенесена.`,
        );
  const documents = index(many(one(root, "documents"), "document"));
  const media: TransferMedia[] = [...documents].map(([id, n]) => {
    const personIds = new Set<string>(),
      portraitIds: string[] = [];
    for (const person of nodes)
      for (const ref of many(one(person, "documents"), "document"))
        if (ref.attrs.id === id) {
          personIds.add(ids.get(person.attrs.id)!);
          if (ref.attrs.ismain === "1")
            portraitIds.push(ids.get(person.attrs.id)!);
        }
    for (const detail of many(one(n, "details"), "detail"))
      for (const ref of many(detail, "person"))
        personIds.add(resolvePerson(ref.attrs.id).id);
    return {
      id: `${namespace}-m${id}`,
      file: (n.attrs.path || "").replace(/\\/g, "/"),
      title: n.attrs.title || "Документ XML",
      personIds: [...personIds],
      portraitIds,
      embedded: textOf(n, "data") || textOf(n, "base64") || undefined,
      photo: {
        description: addNotes(textOf(n, "comment") || undefined, [
          ...extraAttributes(n, ["id", "path", "title"], "document", warnings),
          ...extraChildren(
            n,
            ["details", "comment", "data", "base64", "sources"],
            "document",
            warnings,
          ),
        ]),
        tags: [],
      },
    };
  });
  for (const node of nodes)
    for (const ref of many(one(node, "documents"), "document"))
      if (!documents.has(ref.attrs.id))
        warnings.add(`Документ ${ref.attrs.id} отсутствует в XML.`);
  const links: Family["links"] = many(one(root, "drevoLinks"), "link").map(
    (node, i) => ({
      id: `${namespace}-l${i}`,
      from: resolvePerson(node.attrs.from).id,
      to: resolvePerson(node.attrs.to).id,
      type: node.attrs.type as NonNullable<Family["links"]>[number]["type"],
      note: node.text,
    }),
  );
  if (people.some((p) => p.events?.some((e) => e.dateText)))
    warnings.add(
      "Приблизительные даты и двойной календарь сохранены исходным текстом без подстановки точных дат.",
    );
  if (nodes.some((node) => one(node, "nearest")?.children.length))
    warnings.add(
      "Блоки nearest/relcode не перенесены: они не считаются подтверждённым родством.",
    );
  if (families.size)
    warnings.add(
      `Раздел families (${families.size} родов): структура, дополнительные свойства и документы родов не переносятся. Названия привязанных родов сохранены в биографиях.`,
    );
  const placeList = [...places.values()];
  const datedPlaces = placeList.filter((place) => place.attrs.date).length;
  const alternateNames = placeList.filter((place) =>
    [place.attrs.name, place.attrs.nameshort].some(
      (name) => name && name !== place.attrs.fullname,
    ),
  ).length;
  const parentPlaces = placeList.filter((place) =>
    one(place, "parent_id"),
  ).length;
  const sourcedPlaces = placeList.filter(
    (place) => one(place, "sources")?.children.length,
  ).length;
  if (datedPlaces)
    warnings.add(
      `Даты исторических названий мест (${datedPlaces}) не перенесены.`,
    );
  if (alternateNames)
    warnings.add(
      `Альтернативные названия мест (${alternateNames}) не перенесены; основное название сохранено там, где место используется.`,
    );
  if (parentPlaces)
    warnings.add(`Иерархия родительских мест (${parentPlaces}) не перенесена.`);
  if (sourcedPlaces)
    warnings.add(
      `Ссылки на источники для мест (${sourcedPlaces}) не перенесены.`,
    );
  const eventDocuments = [...events.values()].filter(
    (event) => one(event, "documents")?.children.length,
  ).length;
  if (eventDocuments)
    warnings.add(
      `Текущий XML-импортёр не переносит связи документов с ${eventDocuments} событиями.`,
    );
  const documentSources = [...documents.values()].filter(
    (document) => one(document, "sources")?.children.length,
  ).length;
  if (documentSources)
    warnings.add(
      `Текущий XML-импортёр не переносит связи источников с ${documentSources} документами.`,
    );
  const unlinkedSources = [...sourceNodes.keys()].filter(
    (id) => !usedSources.has(id),
  );
  if (unlinkedSources.length)
    warnings.add(
      `Источники без ссылок на людей или события (${unlinkedSources.length}) не перенесены как отдельный каталог.`,
    );
  if (one(root, "tasks")?.children.length)
    warnings.add(
      "Раздел tasks не представлен в модели Drevo и не перенесён. Сохраните исходный XML.",
    );
  for (const child of root.children.filter(
    (node) =>
      ![
        "persons",
        "events",
        "documents",
        "places",
        "sources",
        "families",
        "tasks",
        "drevoLinks",
      ].includes(node.name),
  ))
    if (child.children.length || child.text.trim())
      warnings.add(
        `Раздел ${child.name} не перенесён. Сохраните исходный XML.`,
      );
  warnings.add(
    "Импорт добавляет новые карточки; совпадения по имени не объединяются автоматически.",
  );
  return {
    family: validateFamily({
      title: "Импорт «Древа Жизни»",
      description: "",
      demo: false,
      people,
      links,
      photos: [],
    }),
    media,
    warnings: [...warnings],
    version: "Agelong Tree XML",
  };
}
