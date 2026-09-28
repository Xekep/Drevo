import { SaxesParser } from "saxes";
import type { Family, Person, PersonEvent } from "./types.ts";
import { validDate } from "./dates.ts";
import { validateFamily } from "./validation.ts";
import {
  TRANSFER_PACKAGE_LIMIT,
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

function parseXml(text: string): XmlNode {
  if (new TextEncoder().encode(text).length > TRANSFER_PACKAGE_LIMIT)
    throw new Error("XML больше 256 МБ");
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
  const place = (node: XmlNode, tag = "place") => {
    const ref = one(node, tag);
    return ref?.text || (ref && places.get(ref.attrs.id)?.attrs.fullname) || "";
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
      birthPlace: place(n, "bplace"),
      deathPlace: place(n, "dplace") || undefined,
      occupation: a.occu || undefined,
      biography: textOf(n, "comment") || undefined,
      sources: [],
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
    const residence = place(n);
    if (residence)
      p.events!.push({
        id: `${namespace}-r${i}`,
        type: "residence",
        place: residence,
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
    const known = new Set([
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
    ]);
    for (const key of Object.keys(a))
      if (!known.has(key)) warnings.add(`Атрибут person.${key} не перенесён.`);
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
        location = place(n),
        description = textOf(n, "comment");
      if (birth || death) {
        if (date) {
          if (birth && !p.birth) p.birth = date;
          if (death && !p.death) p.death = date;
        }
        if (death) p.deceased = true;
        if (location) {
          if (birth && !p.birthPlace) p.birthPlace = location;
          if (death && !p.deathPlace) p.deathPlace = location;
        }
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
          place: location || undefined,
          description: description || undefined,
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
      photo: { description: textOf(n, "comment") || undefined, tags: [] },
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
  for (const tag of ["sources", "families", "tasks"])
    if (one(root, tag)?.children.length)
      warnings.add(
        `Раздел ${tag} не представлен в модели Drevo и не перенесён. Сохраните исходный XML.`,
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
