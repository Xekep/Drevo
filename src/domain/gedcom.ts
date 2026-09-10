import type {
  Family,
  Person,
  PersonEvent,
  Source,
  FamilyLink,
} from "./types.ts";
import { EXTRA_LINK_TYPES } from "./types.ts";
import { validDate, fullName, safeUrl } from "./dates.ts";
import { validateFamily } from "./validation.ts";
import { EVENT_NAMES } from "./person-events.ts";

type Node = { tag: string; value: string; xref?: string; children: Node[] };
const child = (n: Node, tag: string) => n.children.find((c) => c.tag === tag);
const value = (n: Node, tag: string) => child(n, tag)?.value || "";
const children = (n: Node, tag: string) =>
  n.children.filter((c) => c.tag === tag);
const months = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const eventTags: Record<string, PersonEvent["type"]> = {
  RESI: "residence",
  EMIG: "move",
  IMMI: "move",
  EDUC: "education",
  OCCU: "work",
  _MILT: "military",
  MARR: "marriage",
  DIV: "divorce",
  CHR: "baptism",
  BAPM: "baptism",
  BURI: "burial",
  EVEN: "other",
  FACT: "other",
};
function parse(text: string): Node[] {
  if (text.length > 8 * 1024 * 1024 || text.includes("\0"))
    throw new Error("GEDCOM должен быть текстовым файлом UTF-8 до 8 МБ");
  const roots: Node[] = [],
    stack: Node[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  if (lines.length > 200000) throw new Error("Слишком много строк GEDCOM");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const match =
      /^(\d+)\s+(?:(@[^@\s]+@)\s+)?([A-Za-z_][A-Za-z_0-9]*)(?:[ \t](.*))?$/.exec(
        lines[i],
      );
    if (!match) throw new Error(`Неверная строка GEDCOM: ${i + 1}`);
    const level = Number(match[1]),
      tag = match[3].toUpperCase();
    if (level > 50 || (level && !stack[level - 1]))
      throw new Error(`Неверная вложенность GEDCOM: строка ${i + 1}`);
    if (tag === "CONT" || tag === "CONC") {
      if (!level) throw new Error("Продолжение строки без родительской записи");
      stack[level - 1].value += (tag === "CONT" ? "\n" : "") + (match[4] || "");
      continue;
    }
    const node: Node = {
      tag,
      xref: match[2],
      value: match[4] || "",
      children: [],
    };
    if (level) stack[level - 1].children.push(node);
    else roots.push(node);
    stack.length = level;
    stack[level] = node;
  }
  if (roots[0]?.tag !== "HEAD" || roots.at(-1)?.tag !== "TRLR")
    throw new Error("В GEDCOM отсутствует начало HEAD или завершение TRLR");
  return roots;
}
export function gedcomDate(text: string): string | undefined {
  const match = /^(?:(\d{1,2}) )?(?:([A-Z]{3}) )?(\d{4})$/.exec(
    text.trim().toUpperCase(),
  );
  if (!match) return undefined;
  const month = match[2] ? months.indexOf(match[2]) + 1 : 0;
  if ((match[2] && !month) || (match[1] && !month)) return undefined;
  const date = `${match[3]}${month ? `-${String(month).padStart(2, "0")}` : ""}${match[1] ? `-${match[1].padStart(2, "0")}` : ""}`;
  return validDate(date) ? date : undefined;
}
function exportDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${d ? `${Number(d)} ` : ""}${m ? `${months[Number(m) - 1]} ` : ""}${y}`;
}

/** Поддерживаемое ядро 5.5.1/7.0. Приблизительные даты сохраняются текстом, медиа не скачиваются. */
export function importGedcom(
  text: string,
  namespace: string,
): { family: Family; warnings: string[] } {
  const roots = parse(text),
    header = roots[0],
    warnings = new Set<string>();
  const version = child(header, "GEDC")
    ? value(child(header, "GEDC")!, "VERS")
    : "";
  if (!/^(5\.5(?:\.1)?|7\.0(?:\.\d+)?)$/.test(version))
    throw new Error(
      `Поддерживаются GEDCOM 5.5, 5.5.1 и 7.0; версия файла: ${version || "не указана"}`,
    );
  const encoding = value(header, "CHAR").toUpperCase();
  if (encoding && !["UTF-8", "ASCII"].includes(encoding))
    throw new Error(
      `Кодировка ${encoding} не поддерживается. Выгрузите файл в UTF-8.`,
    );
  const records = new Map<string, Node>();
  for (const n of roots)
    if (n.xref) {
      if (records.has(n.xref))
        throw new Error(`Повтор идентификатора GEDCOM: ${n.xref}`);
      records.set(n.xref, n);
    }
  const individuals = roots.filter((n) => n.tag === "INDI");
  if (!individuals.length || individuals.length > 10000)
    throw new Error("В файле должно быть от 1 до 10 000 людей");
  const ids = new Map(
    individuals.map((n, i) => [n.xref, `${namespace}-p${i + 1}`]),
  );
  if (ids.has(undefined))
    throw new Error("У человека отсутствует идентификатор GEDCOM");
  const notes = (n: Node) =>
    children(n, "NOTE")
      .map((s) => records.get(s.value)?.value || s.value)
      .filter(Boolean)
      .join("\n\n")
      .replace(/@@/g, "@");
  const sources = (n: Node): Source[] =>
    children(n, "SOUR").map((s) => {
      const record = records.get(s.value),
        url = value(s, "_URL") || (record ? value(record, "WWW") : "");
      return {
        title: record
          ? value(record, "TITL") || value(record, "ABBR") || "Источник"
          : s.value.replace(/@@/g, "@"),
        type: value(s, "_TYPE"),
        reference: value(s, "PAGE"),
        note:
          [
            record && notes(record),
            notes(s),
            child(s, "DATA") && value(child(s, "DATA")!, "TEXT"),
          ]
            .filter(Boolean)
            .join("\n") || undefined,
        url: /^https?:\/\//i.test(url) && safeUrl(url) ? url : undefined,
      };
    });
  let eventId = 0;
  function event(n: Node, fallback?: string): PersonEvent {
    const raw = value(n, "DATE"),
      date = gedcomDate(raw);
    const period = /^FROM (.+) TO (.+)$/.exec(raw),
      start = period && gedcomDate(period[1]),
      end = period && gedcomDate(period[2]);
    if (raw && !date && !(start && end))
      warnings.add(
        "Приблизительные даты, старый стиль и нестандартные календари сохранены в исходной формулировке, без подстановки точных дат.",
      );
    return {
      id: `${namespace}-e${++eventId}`,
      type: eventTags[n.tag] || "other",
      title:
        value(n, "TYPE") ||
        (n.value && n.value !== "Y" ? n.value : fallback) ||
        undefined,
      date: date || start || undefined,
      endDate: start && end ? end : undefined,
      dateText: raw && !date && !(start && end) ? raw : undefined,
      place: value(n, "PLAC") || undefined,
      description: notes(n) || undefined,
      sources: sources(n),
    };
  }
  const people: Person[] = individuals.map((n) => {
    const nameNode = child(n, "NAME"),
      nameText = nameNode?.value || "",
      slash = /^(.*?)\/(.*?)\/(.*)$/.exec(nameText);
    const given =
      (nameNode && value(nameNode, "GIVN")) ||
      slash?.[1].trim() ||
      nameText.trim();
    const surname =
      (nameNode && value(nameNode, "SURN")) || slash?.[2].trim() || "";
    if (!given || !surname)
      warnings.add(
        "Для людей без имени или фамилии показаны явные подписи «Имя неизвестно» / «Фамилия неизвестна». Уточните их после импорта.",
      );
    const birth = child(n, "BIRT"),
      death = child(n, "DEAT");
    const events = n.children
      .filter((c) => Object.hasOwn(eventTags, c.tag))
      .map((c) => event(c));
    for (const [node, label] of [
      [birth, "Рождение"],
      [death, "Уход из жизни"],
    ] as const)
      if (node && value(node, "DATE") && !gedcomDate(value(node, "DATE")))
        events.push(event(node, label));
    const p: Person = {
      id: ids.get(n.xref)!,
      name: given || "Имя неизвестно",
      surname: surname || "Фамилия неизвестна",
      patronymic: value(n, "_PATR"),
      sex: value(n, "SEX") === "M" ? "m" : value(n, "SEX") === "F" ? "f" : "u",
      birth: birth ? gedcomDate(value(birth, "DATE")) || "" : "",
      death: death ? gedcomDate(value(death, "DATE")) : undefined,
      deceased: death && death.value !== "N" ? true : undefined,
      birthPlace: birth ? value(birth, "PLAC") : "",
      deathPlace: death ? value(death, "PLAC") || undefined : undefined,
      biography: notes(n) || undefined,
      occupation: value(n, "OCCU") || undefined,
      maidenName: value(n, "_MAIDEN") || undefined,
      sources: [
        ...sources(n),
        ...(birth ? sources(birth) : []),
        ...(death ? sources(death) : []),
      ],
      parents: [],
      spouses: [],
      generation: 1,
      column: 0,
      events: events.length ? events : undefined,
    };
    const extension = value(n, "_DREVO");
    if (extension) {
      try {
        const extra = JSON.parse(extension);
        for (const key of [
          "name",
          "surname",
          "patronymic",
          "maidenName",
          "birth",
          "death",
          "birthPlace",
          "deathPlace",
          "biography",
          "occupation",
          "sources",
          "events",
          "awards",
          "parentageComplete",
          "deceased",
        ] as const)
          if (Object.hasOwn(extra, key))
            Object.assign(p, { [key]: extra[key] });
      } catch {
        throw new Error("Повреждены дополнительные сведения Drevo в GEDCOM");
      }
    }
    for (const c of n.children)
      if (
        ![
          "NAME",
          "SEX",
          "BIRT",
          "DEAT",
          "NOTE",
          "SOUR",
          "FAMC",
          "FAMS",
          "ASSO",
          "ADOP",
          "CHAN",
          "RIN",
          "UID",
          "_UID",
          "_PATR",
          "_MAIDEN",
          "_DREVO",
          "OBJE",
        ].includes(c.tag) &&
        !Object.hasOwn(eventTags, c.tag)
      )
        warnings.add(
          `Поле INDI.${c.tag} не перенесено. Сохраните исходный GEDCOM.`,
        );
    return p;
  });
  const map = new Map(people.map((p) => [p.id, p])),
    links: FamilyLink[] = [];
  const personRef = (ref: string) => {
    const id = ids.get(ref);
    if (!id) throw new Error(`Связь с отсутствующим человеком ${ref}`);
    return map.get(id)!;
  };
  const addLink = (
    from: string,
    to: string,
    type: FamilyLink["type"],
    note?: string,
  ) => {
    if (!links.some((l) => l.from === from && l.to === to && l.type === type))
      links.push({
        id: `${namespace}-l${links.length + 1}`,
        from,
        to,
        type,
        note,
      });
  };
  const families = roots.filter((n) => n.tag === "FAM");
  for (const f of families) {
    for (const n of f.children)
      if (
        ![
          "HUSB",
          "WIFE",
          "CHIL",
          "_DREVO_PARENT",
          "_DREVO_UNMARRIED",
          "NOTE",
          "SOUR",
          "CHAN",
          "RIN",
          "UID",
          "_UID",
        ].includes(n.tag) &&
        !Object.hasOwn(eventTags, n.tag)
      )
        warnings.add(
          `Поле FAM.${n.tag} не перенесено. Сохраните исходный GEDCOM.`,
        );
    const parents = [
      ...children(f, "HUSB"),
      ...children(f, "WIFE"),
      ...children(f, "_DREVO_PARENT"),
    ].map((n) => personRef(n.value));
    const uniqueParents = [...new Map(parents.map((p) => [p.id, p])).values()];
    if (uniqueParents.length > 2)
      warnings.add(
        "Семьи с более чем двумя указанными родителями сохранены как записано; проверьте характер родства.",
      );
    const spousePair = uniqueParents.slice(0, 2);
    if (spousePair.length === 2 && value(f, "_DREVO_UNMARRIED") !== "Y") {
      for (const p of spousePair)
        p.spouses = [
          ...new Set([
            ...p.spouses,
            ...spousePair.filter((s) => s.id !== p.id).map((s) => s.id),
          ]),
        ];
    }
    for (const c of children(f, "CHIL")) {
      const person = personRef(c.value),
        individual = records.get(c.value)!;
      const parentRef = children(individual, "FAMC").find(
        (n) => n.value === f.xref,
      );
      const pedigree = parentRef ? value(parentRef, "PEDI").toLowerCase() : "";
      if (pedigree && !["birth", "adopted", "foster"].includes(pedigree)) {
        warnings.add(
          `Родство PEDI=${pedigree} не перенесено как кровное. Уточните связь для ${fullName(person)}.`,
        );
        continue;
      }
      const adoption = children(individual, "ADOP").find(
        (n) => value(n, "FAMC") === f.xref,
      );
      const adoptionRole =
        adoption && child(adoption, "FAMC")
          ? value(child(adoption, "FAMC")!, "ADOP")
          : "";
      for (const p of uniqueParents) {
        const adoptThis =
          adoption &&
          (!adoptionRole ||
            adoptionRole === "BOTH" ||
            children(f, adoptionRole).some((n) => ids.get(n.value) === p.id));
        if (pedigree === "adopted" || adoptThis)
          addLink(p.id, person.id, "adoptive_parent");
        else if (pedigree === "foster") addLink(p.id, person.id, "guardian");
        else person.parents = [...new Set([...person.parents, p.id])];
      }
    }
    for (const p of spousePair)
      for (const e of f.children.filter((n) =>
        Object.hasOwn(eventTags, n.tag),
      )) {
        // Наши события уже сохранены расширением без потери полей.
        const individual = individuals.find((n) => ids.get(n.xref) === p.id)!;
        if (!value(individual, "_DREVO")) {
          const imported = event(e);
          const partner = spousePair.find((s) => s.id !== p.id);
          if (partner)
            imported.description = [
              imported.description,
              `Участник: ${fullName(partner)}`,
            ]
              .filter(Boolean)
              .join("\n");
          (p.events ||= []).push(imported);
        }
      }
  }
  for (const n of individuals) {
    for (const assoc of children(n, "ASSO")) {
      const type = value(assoc, "RELA").toLowerCase() as FamilyLink["type"];
      if (EXTRA_LINK_TYPES.includes(type))
        addLink(
          personRef(assoc.value).id,
          ids.get(n.xref)!,
          type,
          notes(assoc) || undefined,
        );
      else
        warnings.add(
          `Дополнительная связь «${type || "без типа"}» не перенесена автоматически.`,
        );
    }
    for (const ref of [...children(n, "FAMC"), ...children(n, "FAMS")]) {
      if (records.get(ref.value)?.tag !== "FAM")
        throw new Error(`Не найдена семья ${ref.value}`);
      const f = records.get(ref.value)!;
      const actual =
        ref.tag === "FAMC"
          ? children(f, "CHIL")
          : [
              ...children(f, "HUSB"),
              ...children(f, "WIFE"),
              ...children(f, "_DREVO_PARENT"),
            ];
      if (!actual.some((c) => c.value === n.xref))
        throw new Error(
          `Несогласованные ссылки на семью ${ref.value}: проверьте исходный GEDCOM`,
        );
    }
  }
  if (
    roots.some((n) => n.tag === "OBJE") ||
    individuals.some((n) => children(n, "OBJE").length)
  )
    warnings.add(
      "Файлы фотографий и документов не загружаются из GEDCOM. Добавьте оригиналы в галерею отдельно.",
    );
  warnings.add(
    "Импорт добавляет новые карточки. Совпадения по имени не объединяются автоматически.",
  );
  return {
    family: validateFamily({
      title: "Импорт GEDCOM",
      description: "",
      demo: false,
      people,
      links,
      photos: [],
    }),
    warnings: [...warnings],
  };
}

/** Стандартные записи + расширение _DREVO для точного обратного переноса наших полей. */
export function exportGedcom(family: Family): string {
  const lines: string[] = [];
  function emit(level: number, tag: string, text = "") {
    const parts = text.replace(/\r\n?/g, "\n").replace(/\0/g, "").split("\n");
    for (let i = 0; i < parts.length; i++) {
      const chars = [...parts[i]];
      if (!chars.length)
        lines.push(`${i ? level + 1 : level} ${i ? "CONT" : tag}`);
      for (let start = 0; start < chars.length; start += 50)
        lines.push(
          `${i || start ? level + 1 : level} ${start ? "CONC" : i ? "CONT" : tag} ${chars.slice(start, start + 50).join("")}`,
        );
    }
  }
  const ids = new Map(family.people.map((p, i) => [p.id, `@I${i + 1}@`]));
  const groups = new Map<
    string,
    { id: string; parents: string[]; children: string[]; married: boolean }
  >();
  function group(parents: string[], married = false) {
    const key = JSON.stringify([...parents].sort());
    if (!groups.has(key))
      groups.set(key, {
        id: `@F${groups.size + 1}@`,
        parents: [...parents],
        children: [],
        married,
      });
    const g = groups.get(key)!;
    g.married ||= married;
    return g;
  }
  for (const p of family.people) {
    if (p.parents.length) group(p.parents).children.push(p.id);
    for (const spouse of p.spouses) group([p.id, spouse], true);
  }
  const sourceRecords: Source[] = [];
  function citation(level: number, source: Source) {
    sourceRecords.push(source);
    emit(level, "SOUR", `@S${sourceRecords.length}@`);
    if (source.reference) emit(level + 1, "PAGE", source.reference);
    if (source.type) emit(level + 1, "_TYPE", source.type);
    if (source.url) emit(level + 1, "_URL", source.url);
    if (source.note) emit(level + 1, "NOTE", source.note);
  }
  emit(0, "HEAD");
  emit(1, "SOUR", "DREVO");
  emit(1, "GEDC");
  emit(2, "VERS", "5.5.1");
  emit(2, "FORM", "LINEAGE-LINKED");
  emit(1, "CHAR", "UTF-8");
  emit(1, "SUBM", "@SUB1@");
  emit(0, "@SUB1@ SUBM");
  emit(1, "NAME", "Семейный архив Drevo");
  for (const p of family.people) {
    emit(0, `${ids.get(p.id)} INDI`);
    emit(
      1,
      "NAME",
      `${[p.name, p.patronymic].filter(Boolean).join(" ")} /${p.surname.replace(/\//g, " ")}/`,
    );
    emit(2, "GIVN", [p.name, p.patronymic].filter(Boolean).join(" "));
    emit(2, "SURN", p.surname);
    if (p.sex !== "u") emit(1, "SEX", p.sex.toUpperCase());
    for (const kind of ["birth", "death"] as const)
      if (p[kind] || p[`${kind}Place`] || (kind === "death" && p.deceased)) {
        emit(1, kind === "birth" ? "BIRT" : "DEAT", "Y");
        if (p[kind]) emit(2, "DATE", exportDate(p[kind]));
        if (p[`${kind}Place`]) emit(2, "PLAC", p[`${kind}Place`]!);
      }
    if (p.biography) emit(1, "NOTE", p.biography.replace(/@/g, "@@"));
    if (p.occupation) emit(1, "OCCU", p.occupation);
    for (const source of p.sources) citation(1, source);
    for (const e of p.events || []) {
      const tag =
        (
          {
            residence: "RESI",
            move: "EMIG",
            education: "EDUC",
            work: "OCCU",
            baptism: "CHR",
            burial: "BURI",
          } as Record<string, string>
        )[e.type] || "EVEN";
      emit(
        1,
        tag,
        tag === "OCCU" || tag === "EDUC" ? e.title || EVENT_NAMES[e.type] : "",
      );
      emit(2, "TYPE", e.title || EVENT_NAMES[e.type]);
      if (e.date)
        emit(
          2,
          "DATE",
          e.endDate
            ? `FROM ${exportDate(e.date)} TO ${exportDate(e.endDate)}`
            : exportDate(e.date),
        );
      else if (e.dateText) emit(2, "DATE", e.dateText);
      else if (e.endDate) emit(2, "DATE", `TO ${exportDate(e.endDate)}`);
      if (e.place) emit(2, "PLAC", e.place);
      if (e.description) emit(2, "NOTE", e.description.replace(/@/g, "@@"));
      for (const source of e.sources || []) citation(2, source);
    }
    for (const g of groups.values()) {
      if (g.children.includes(p.id)) {
        emit(1, "FAMC", g.id);
        emit(2, "PEDI", "birth");
      }
      if (g.parents.includes(p.id)) emit(1, "FAMS", g.id);
    }
    for (const l of family.links || [])
      if (l.to === p.id) {
        emit(1, "ASSO", ids.get(l.from)!);
        emit(2, "RELA", l.type);
        if (l.note) emit(2, "NOTE", l.note.replace(/@/g, "@@"));
      }
    const {
      photo: _photo,
      createdBy: _createdBy,
      id: _id,
      parents: _parents,
      spouses: _spouses,
      generation: _generation,
      column: _column,
      birthLocation: _birthLocation,
      deathLocation: _deathLocation,
      ...extra
    } = p;
    void [
      _photo,
      _createdBy,
      _id,
      _parents,
      _spouses,
      _generation,
      _column,
      _birthLocation,
      _deathLocation,
    ];
    emit(1, "_DREVO", JSON.stringify(extra));
  }
  for (const g of groups.values()) {
    emit(0, `${g.id} FAM`);
    const parents = [...g.parents].sort(
      (a, b) =>
        (family.people.find((p) => p.id === a)?.sex === "m" ? -1 : 0) -
        (family.people.find((p) => p.id === b)?.sex === "m" ? -1 : 0),
    );
    const usedRoles = new Set<string>();
    for (const id of parents) {
      const sex = family.people.find((p) => p.id === id)?.sex;
      const preferred = sex === "f" ? "WIFE" : "HUSB";
      const role = !usedRoles.has(preferred)
        ? preferred
        : !usedRoles.has("HUSB")
          ? "HUSB"
          : !usedRoles.has("WIFE")
            ? "WIFE"
            : "_DREVO_PARENT";
      emit(1, role, ids.get(id)!);
      usedRoles.add(role);
    }
    if (!g.married) emit(1, "_DREVO_UNMARRIED", "Y");
    else emit(1, "MARR", "Y");
    for (const id of g.children) emit(1, "CHIL", ids.get(id)!);
  }
  sourceRecords.forEach((s, i) => {
    emit(0, `@S${i + 1}@ SOUR`);
    emit(1, "TITL", s.title);
  });
  emit(0, "TRLR");
  return lines.join("\r\n") + "\r\n";
}
