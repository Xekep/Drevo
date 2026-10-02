import type {
  Family,
  Person,
  PersonValueClaim,
  PersonEvent,
  PlaceLocation,
  Source,
  FamilyLink,
  FamilyUnion,
  UnionMilestone,
} from "./types.ts";
import { EXTRA_LINK_TYPES } from "./types.ts";
import { isClaimConfidence } from "./claim-confidence.ts";
import { validDate, fullName, safeUrl } from "./dates.ts";
import { validateFamily } from "./validation.ts";
import { EVENT_NAMES } from "./person-events.ts";
import { parseDocumentDetails } from "../shared/document-details.ts";
import {
  familyMedia,
  TRANSFER_TEXT_LIMIT,
  type GenealogyImport,
  type GedcomVersion,
  type TransferMedia,
} from "./genealogy-transfer.ts";

const CLAIM_CONFIDENCE_TAGS = [
  "_DREVO_DATE_CONFIDENCE",
  "_DREVO_PLACE_CONFIDENCE",
  "_DREVO_OCCUPATION_CONFIDENCE",
  "_DREVO_BIRTH_SURNAME_CONFIDENCE",
] as const;

function stripArchiveSourceIds(sources?: Source[]) {
  for (const source of sources || []) {
    delete source.catalogId;
    delete source.documentId;
    delete source.documentPage;
  }
}

// GEDCOM transfers readable citations, not archive-local catalogue/document IDs.
function inlineUnionSources(union: FamilyUnion): FamilyUnion {
  const copy = structuredClone(union);
  for (const sources of [copy.sources, copy.formation?.sources, copy.ending?.sources,
    copy.divorce?.sources, copy.ongoing?.sources])
    stripArchiveSourceIds(sources);
  return copy;
}

type Node = {
  tag: string;
  value: string;
  xref?: string;
  pointer?: boolean;
  children: Node[];
};
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
  CENS: "other",
  NATU: "other",
  PROB: "other",
  WILL: "other",
  RETI: "other",
  GRAD: "education",
  CREM: "burial",
  ORDN: "other",
  BARM: "other",
  BASM: "other",
  BLES: "other",
  CONF: "other",
  FCOM: "other",
  DSCR: "other",
  RELI: "other",
  NATI: "other",
  CAST: "other",
  PROP: "other",
  SSN: "other",
  IDNO: "other",
  NCHI: "other",
  NMR: "other",
  TITL: "other",
  ANUL: "divorce",
  DIVF: "divorce",
  ENGA: "other",
  MARB: "other",
  MARC: "other",
  MARL: "other",
  MARS: "other",
};
function parse(text: string): Node[] {
  if (
    new TextEncoder().encode(text).length > TRANSFER_TEXT_LIMIT ||
    text.includes("\0")
  )
    throw new Error("GEDCOM должен быть текстовым файлом до 32 МБ");
  const roots: Node[] = [],
    stack: Node[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const headerEnd = lines.findIndex((line, i) => i > 0 && /^0\s/.test(line));
  const headerLines = lines.slice(0, headerEnd < 0 ? undefined : headerEnd);
  const gedcLine = headerLines.findIndex((line) => /^1\s+GEDC\s*$/i.test(line));
  const versionLine =
    gedcLine < 0
      ? ""
      : headerLines
          .slice(gedcLine + 1)
          .find((line) => /^2\s+VERS\s/i.test(line)) || "";
  const modern = /^2\s+VERS 7\.0(?:\.\d+)?\s*$/i.test(versionLine);
  const decode = (s: string) =>
    modern ? s.replace(/^@@/, "@") : s.replace(/@@/g, "@");
  if (lines.length > 500000) throw new Error("Слишком много строк GEDCOM");
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
      if (modern && tag === "CONC")
        throw new Error("CONC не допускается в GEDCOM 7");
      stack[level - 1].value +=
        (tag === "CONT" ? "\n" : "") + decode(match[4] || "");
      stack.length = level;
      continue;
    }
    const node: Node = {
      tag,
      xref: match[2],
      value: decode(match[4] || ""),
      pointer: /^@[^@\s]+@$/.test(match[4] || ""),
      children: [],
    };
    if (level) stack[level - 1].children.push(node);
    else roots.push(node);
    stack.length = level;
    stack[level] = node;
  }
  if (roots[0]?.tag !== "HEAD" || roots.at(-1)?.tag !== "TRLR")
    throw new Error("В GEDCOM отсутствует начало HEAD или завершение TRLR");
  if (
    roots.filter((n) => n.tag === "HEAD").length !== 1 ||
    roots.filter((n) => n.tag === "TRLR").length !== 1
  )
    throw new Error("В GEDCOM должны быть ровно один HEAD и один TRLR");
  return roots;
}
function gedcomDate(text: string): string | undefined {
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

function portableDate(
  raw: string,
  modern: boolean,
): { date: string; phrase?: string } {
  const date = raw.replace(
    /@#D(GREGORIAN|JULIAN|HEBREW|FRENCH R)@ ?/g,
    (_all, calendar: string) => `${calendar.replace(" ", "_")} `,
  );
  const atom =
    "(?:(?:GREGORIAN|JULIAN|HEBREW|FRENCH_R) )?(?:(?:[0-9]{1,2} )?[A-Z_]{3,} )?[0-9]{1,4}(?: BCE)?";
  const valid = new RegExp(
    `^(?:${atom}|(?:ABT|CAL|EST|BEF|AFT|TO) ${atom}|FROM ${atom}(?: TO ${atom})?|BET ${atom} AND ${atom})$`,
  ).test(date);
  if (!valid)
    return modern
      ? { date: "", phrase: raw.replace(/^\((.*)\)$/, "$1") }
      : { date: `(${raw.replace(/^\((.*)\)$/, "$1")})` };
  return {
    date: modern
      ? date
      : date.replace(
          /(GREGORIAN|JULIAN|HEBREW|FRENCH_R) /g,
          (_all, calendar: string) => `@#D${calendar.replace("_", " ")}@ `,
        ),
  };
}

/** Поддерживаемое ядро 5.5.1/7.0. Приблизительные даты сохраняются текстом, медиа не скачиваются. */
export function importGedcom(text: string, namespace: string): GenealogyImport {
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
  for (const node of roots)
    if (
      ![
        "HEAD",
        "TRLR",
        "INDI",
        "FAM",
        "SOUR",
        "REPO",
        "NOTE",
        "SNOTE",
        "OBJE",
        "SUBM",
      ].includes(node.tag)
    )
      warnings.add(
        `Запись ${node.tag} не перенесена. Сохраните исходный GEDCOM.`,
      );
  const supportedExtensions = new Set([
    "_DREVO",
    "_DREVO_PARENT",
    "_DREVO_UNMARRIED",
    "_DREVO_MEDIA",
    "_DREVO_TWIN",
    "_DREVO_CLAIM",
    "_DREVO_UNION_STAGE",
    "_DREVO_EVENT_ID",
    "_DREVO_DOCUMENT_PAGE",
    ...CLAIM_CONFIDENCE_TAGS,
    "_MAIDEN",
    "_UID",
    "_PATR",
    "_TYPE",
    "_URL",
    "_PRIM",
    ...Object.keys(eventTags).filter((tag) => tag.startsWith("_")),
  ]);
  for (const root of roots) {
    const nested: Array<{ node: Node; parentTag: string }> = root.children.map(
      (node) => ({ node, parentTag: root.tag }),
    );
    while (nested.length) {
      const { node, parentTag } = nested.pop()!;
      if (
        node.tag.startsWith("_") &&
        !supportedExtensions.has(node.tag) &&
        !["INDI", "FAM"].includes(parentTag)
      )
        warnings.add(
          `Поле ${node.tag} не перенесено. Сохраните исходный GEDCOM.`,
        );
      for (const child of node.children)
        nested.push({ node: child, parentTag: node.tag });
    }
  }
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
  const notes = (n: Node, exclude?: string) =>
    n.children
      .filter((c) => c.tag === "NOTE" || c.tag === "SNOTE")
      .map((s) => {
        if (!s.pointer) return s.value;
        const record = records.get(s.value);
        if (!record || !["NOTE", "SNOTE"].includes(record.tag))
          throw new Error(`Не найдена заметка ${s.value}`);
        return record.value;
      })
      .filter((text) => text && text !== exclude)
      .join("\n\n");
  const citationObjects: Array<{ source: Source; object: Node; page?: number }> = [];
  const citationObjectBySource = new Map<Source, (typeof citationObjects)[number]>();
  const usedRepositories = new Set<string>();
  const sources = (n: Node): Source[] =>
    children(n, "SOUR").map((s) => {
      const record = s.pointer ? records.get(s.value) : undefined,
        noteUrl = record
          ? children(record, "NOTE")
              .map((note) => /^URL: (https?:\/\/\S+)$/i.exec(note.value)?.[1])
              .find(Boolean)
          : undefined,
        url =
          value(s, "_URL") ||
          (record ? value(record, "_URL") || value(record, "WWW") : "") ||
          noteUrl ||
          "";
      if (s.pointer && record?.tag !== "SOUR")
        throw new Error(`Не найден источник ${s.value}`);
      const data = child(s, "DATA"),
        citationEvent = child(s, "EVEN"),
        eventRole = citationEvent && child(citationEvent, "ROLE"),
        citationDetails = [
          data && value(data, "DATE")
            ? `Дата сведений в источнике: ${value(data, "DATE")}`
            : "",
          ...(data ? children(data, "TEXT") : []).map((entry, index) =>
            entry.value
              ? `Текст свидетельства ${index + 1}: ${entry.value}`
              : "",
          ),
          citationEvent?.value
            ? `Тип события в цитате: ${citationEvent.value}`
            : "",
          citationEvent && value(citationEvent, "PHRASE")
            ? `Пояснение события: ${value(citationEvent, "PHRASE")}`
            : "",
          eventRole?.value ? `Роль в событии: ${eventRole.value}` : "",
          eventRole && value(eventRole, "PHRASE")
            ? `Пояснение роли: ${value(eventRole, "PHRASE")}`
            : "",
          value(s, "QUAY")
            ? `Оценка качества цитаты (QUAY): ${value(s, "QUAY")}`
            : "",
        ].filter(Boolean);
      if (citationDetails.length)
        warnings.add(
          "Дополнительные сведения цитаты GEDCOM сохранены в примечании источника, а не в отдельных полях.",
        );
      const repositoryNames: string[] = [], callNumbers: string[] = [], repositoryDetails: string[] = [];
      const repositoryLinks = record ? children(record, "REPO") : [];
      let structuredRepository: Source["repository"];
      for (const link of repositoryLinks) {
        const repository = link.pointer ? records.get(link.value) : undefined;
        const names = repository ? children(repository, "NAME").filter((name) => name.value) : [];
        const calls = children(link, "CALN").filter((call) => call.value);
        const websites = repository ? children(repository, "WWW").filter((site) => site.value) : [];
        const repositoryNote = repository?.tag === "REPO" ? notes(repository) : "";
        const linkNote = notes(link);
        if (repositoryLinks.length === 1 && repository?.tag === "REPO" &&
          names.length === 1 && calls.length <= 1 && websites.length <= 1) {
          usedRepositories.add(link.value);
          structuredRepository = {
            name: names[0].value,
            callNumber: calls[0]?.value || "",
            website: websites[0]?.value || "",
            note: repositoryNote,
            linkNote,
          };
          continue;
        }
        if (repository?.tag === "REPO") {
          usedRepositories.add(link.value);
          for (const name of names) repositoryNames.push(`Хранилище: ${name.value}`);
          for (const website of websites)
            if (website.value) repositoryDetails.push(`Сайт хранилища: ${website.value}`);
          if (repositoryNote) repositoryDetails.push(`Примечание хранилища: ${repositoryNote}`);
        } else if (link.pointer)
          warnings.add(`Хранилище ${link.value} для источника GEDCOM не найдено.`);
        for (const call of calls)
          if (call.value) callNumbers.push(call.value);
        if (linkNote) repositoryDetails.push(`Примечание о хранении: ${linkNote}`);
      }
      const page = value(s, "PAGE");
      if (repositoryNames.length || callNumbers.length || repositoryDetails.length)
        warnings.add("Часть сведений о хранилище GEDCOM сохранена текстом; структура REPO не восстанавливается.");
      const source: Source = {
        title: record
          ? value(record, "TITL") || value(record, "ABBR") || "Источник"
          : s.value,
        type: value(s, "_TYPE") || (record ? value(record, "_TYPE") : ""),
        // PAGE locates this citation; CALN locates the source at its repository.
        reference: page || (structuredRepository ? "" : callNumbers[0] || ""),
        ...(structuredRepository ? { repository: structuredRepository } : {}),
        note:
          [
            record && notes(record, url ? `URL: ${url}` : undefined),
            record && value(record, "TEXT"),
            record && value(record, "AUTH"),
            record && value(record, "PUBL"),
            notes(s),
            ...citationDetails,
            ...repositoryNames,
            ...callNumbers.slice(page ? 0 : 1).map((call) => `Шифр хранилища: ${call}`),
            ...repositoryDetails,
          ]
            .filter(Boolean)
            .join("\n") || undefined,
        url: /^https?:\/\//i.test(url) && safeUrl(url) ? url : undefined,
      };
      const objects = children(s, "OBJE");
      if (objects.length > 1)
        warnings.add("У цитаты несколько файлов; перенесён только первый документ.");
      if (objects.length) {
        const ref = objects[0];
        const object = ref.pointer ? records.get(ref.value) : ref;
        if (!object || object.tag !== "OBJE")
          throw new Error(`Не найдено медиа цитаты ${ref.value}`);
        const rawPage = value(s, "_DREVO_DOCUMENT_PAGE");
        const page = rawPage ? Number(rawPage) : undefined;
        if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 2000))
          throw new Error("Некорректная страница документа цитаты GEDCOM");
        const pending = { source, object, page };
        citationObjects.push(pending);
        citationObjectBySource.set(source, pending);
      }
      return source;
    });
  const eventClaimSources = (node: Node | undefined, date: string, place: string,
    kind: "BIRTH" | "DEATH") => {
    if (!node) return { date: [] as Source[], place: [] as Source[], general: [] as Source[] };
    const citations = sources(node);
    const placeNode = child(node, "PLAC");
    const placeCitations = placeNode ? sources(placeNode) : [];
    const sourceNodes = children(node, "SOUR");
    const dateClaimed: Source[] = [], placeClaimed: Source[] = [], general: Source[] = [];
    citations.forEach((source, index) => {
      const marker = value(sourceNodes[index], "_DREVO_CLAIM");
      if (date && marker === `${kind}_DATE`) dateClaimed.push(source);
      else if (place.trim() && marker === `${kind}_PLACE`) placeClaimed.push(source);
      else if (marker !== "EVENT_PLACE" || !place.trim()) general.push(source);
    });
    if (place.trim()) placeClaimed.push(...placeCitations);
    else if (placeCitations.length) {
      general.push(...placeCitations);
      warnings.add("Источник места без названия сохранён как общий источник карточки.");
    }
    return { date: dateClaimed, place: placeClaimed, general };
  };
  const restoreCitationMedia = (target: Source[] | undefined, parsed: Source[], context: string) => {
    if (!target?.length) return;
    for (let index = 0; index < target.length; index++) {
      const candidate = parsed[index];
      const pending = citationObjectBySource.get(candidate);
      if (!pending) continue;
      if (target[index].title === candidate.title && target[index].reference === candidate.reference)
        pending.source = target[index];
      else warnings.add(`Ссылка на документ ${context} не сопоставлена с цитатой; проверьте GEDCOM.`);
    }
  };
  const claimConfidence = (node: Node | undefined, tag: string) => {
    const status = node ? value(node, tag) : "";
    return isClaimConfidence(status) ? status : undefined;
  };
  const valueClaim = (value: string, sources: Source[], node: Node | undefined,
    tag: string): PersonValueClaim => {
    const confidence = claimConfidence(node, tag);
    return { value, sources, ...(confidence ? { confidence } : {}) };
  };
  const placeLocation = (n?: Node): PlaceLocation | undefined => {
    const place = n && child(n, "PLAC"),
      map = place && child(place, "MAP");
    if (!map) return undefined;
    const latitude = /^([NS])(\d+(?:\.\d+)?)$/.exec(value(map, "LATI")),
      longitude = /^([EW])(\d+(?:\.\d+)?)$/.exec(value(map, "LONG"));
    if (!place?.value || !latitude || !longitude) {
      warnings.add("Координаты места в GEDCOM неполные и не перенесены.");
      return undefined;
    }
    const lat = Number(latitude[2]) * (latitude[1] === "S" ? -1 : 1),
      lon = Number(longitude[2]) * (longitude[1] === "W" ? -1 : 1);
    if (lat > 90 || lat < -90 || lon > 180 || lon < -180) {
      warnings.add("Координаты места в GEDCOM выходят за допустимый диапазон.");
      return undefined;
    }
    return { place: place.value, lat, lon };
  };
  let eventId = 0;
  function event(n: Node, fallback?: string): PersonEvent {
    const raw = value(n, "DATE"),
      date = gedcomDate(raw);
    const phrase = child(n, "DATE") ? value(child(n, "DATE")!, "PHRASE") : "";
    const period = /^FROM (.+) TO (.+)$/.exec(raw),
      start = period && gedcomDate(period[1]),
      end = period && gedcomDate(period[2]);
    if (raw && !date && !(start && end))
      warnings.add(
        "Приблизительные даты, старый стиль и нестандартные календари сохранены в исходной формулировке, без подстановки точных дат.",
      );
    const place = value(n, "PLAC") || undefined;
    const parsedSources = sources(n);
    const sourceNodes = children(n, "SOUR");
    const placeSources = parsedSources.filter((_source, index) =>
      place?.trim() && value(sourceNodes[index], "_DREVO_CLAIM") === "EVENT_PLACE");
    if (!place?.trim() && sourceNodes.some((source) =>
      value(source, "_DREVO_CLAIM") === "EVENT_PLACE"))
      warnings.add("Источник места события без названия сохранён как общий источник события.");
    return {
      id: `${namespace}-e${++eventId}`,
      gedcomTag: n.tag,
      type: eventTags[n.tag] || "other",
      title:
        value(n, "TYPE") ||
        (n.value && n.value !== "Y" ? n.value : fallback) ||
        undefined,
      date: date || start || undefined,
      endDate: start && end ? end : undefined,
      dateText: raw && !date && !(start && end) ? raw : phrase || undefined,
      place,
      ...(placeSources.length ? { placeClaim: { value: place!, sources: placeSources } } : {}),
      location: placeLocation(n),
      description: notes(n) || undefined,
      sources: parsedSources.filter((source) => !placeSources.includes(source)),
    };
  }
  const people: Person[] = individuals.map((n) => {
    const names = children(n, "NAME");
    const nameSurname = (name: Node) =>
      (value(name, "SURN") || /\/(.*?)\//.exec(name.value)?.[1] || "").trim();
    // BIRTH is explicit birth information; MAIDEN is a legacy fallback and
    // can differ from the birth surname after adoption or another name change.
    const birthName = ["BIRTH", "MAIDEN"]
      .flatMap((type) =>
        names.filter(
          (name) => value(name, "TYPE").trim().toUpperCase() === type,
        ),
      )
      .find((name) => nameSurname(name));
    const maidenName = (birthName && nameSurname(birthName)) ||
      value(n, "_MAIDEN") || "";
    const maidenNameSources = birthName && maidenName ? sources(birthName) : [];
    const nameNode = names[0],
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
    const parsedBirthDate = birth ? gedcomDate(value(birth, "DATE")) || "" : "";
    const parsedDeathDate = death ? gedcomDate(value(death, "DATE")) || "" : "";
    const parsedBirthPlace = birth ? value(birth, "PLAC") : "";
    const parsedDeathPlace = death ? value(death, "PLAC") : "";
    const birthSources = eventClaimSources(birth, parsedBirthDate, parsedBirthPlace, "BIRTH");
    const deathSources = eventClaimSources(death, parsedDeathDate, parsedDeathPlace, "DEATH");
    const eventNodes = n.children.filter((c) => Object.hasOwn(eventTags, c.tag));
    const events = eventNodes.map((c) => event(c));
    const occupationNode = child(n, "OCCU");
    const occupation = occupationNode?.value || "";
    const occupationEvent = occupationNode && events[eventNodes.indexOf(occupationNode)];
    const occupationCitations = occupationEvent?.sources || [];
    const occupationSourceNodes = occupationNode ? children(occupationNode, "SOUR") : [];
    const drevoExtra = value(n, "_DREVO");
    const occupationClaimSources = occupation.trim()
      ? occupationCitations.filter((_source, index) => {
          const marker = value(occupationSourceNodes[index], "_DREVO_CLAIM");
          return marker === "OCCUPATION" || (!drevoExtra && !marker);
        })
      : [];
    if (occupationEvent && occupationClaimSources.length)
      occupationEvent.sources = occupationCitations.filter((source) =>
        !occupationClaimSources.includes(source));
    for (const [node, label] of [
      [birth, "Рождение"],
      [death, "Уход из жизни"],
    ] as const)
      if (node && (child(node, "DATE") || notes(node) || sources(node).length)) {
        const parsed = event(node, label);
        if (node === birth) parsed.sources = birthSources.general;
        if (node === death) parsed.sources = deathSources.general;
        events.push(parsed);
      }
    const p: Person = {
      id: ids.get(n.xref)!,
      name: given || "Имя неизвестно",
      surname: surname || "Фамилия неизвестна",
      patronymic: value(n, "_PATR"),
      sex: value(n, "SEX") === "M" ? "m" : value(n, "SEX") === "F" ? "f" : "u",
      birth: parsedBirthDate,
      ...(birthSources.date.length
        ? { birthDateClaim: valueClaim(parsedBirthDate, birthSources.date, birth, "_DREVO_DATE_CONFIDENCE") }
        : {}),
      death: parsedDeathDate || undefined,
      ...(deathSources.date.length
        ? { deathDateClaim: valueClaim(parsedDeathDate, deathSources.date, death, "_DREVO_DATE_CONFIDENCE") }
        : {}),
      deceased: death && death.value !== "N" ? true : undefined,
      birthPlace: parsedBirthPlace,
      ...(birthSources.place.length
        ? { birthPlaceClaim: valueClaim(parsedBirthPlace, birthSources.place, birth, "_DREVO_PLACE_CONFIDENCE") }
        : {}),
      deathPlace: parsedDeathPlace || undefined,
      ...(deathSources.place.length
        ? { deathPlaceClaim: valueClaim(parsedDeathPlace, deathSources.place, death, "_DREVO_PLACE_CONFIDENCE") }
        : {}),
      birthLocation: placeLocation(birth),
      deathLocation: placeLocation(death),
      biography: notes(n) || undefined,
      occupation: occupation || undefined,
      ...(occupationClaimSources.length
        ? { occupationClaim: valueClaim(occupation, occupationClaimSources,
            occupationNode, "_DREVO_OCCUPATION_CONFIDENCE") }
        : {}),
      maidenName: maidenName || undefined,
      ...(maidenNameSources.length
        ? { maidenNameClaim: valueClaim(maidenName, maidenNameSources,
            birthName, "_DREVO_BIRTH_SURNAME_CONFIDENCE") }
        : {}),
      sources: [
        ...sources(n),
        ...birthSources.general,
        ...deathSources.general,
      ],
      parents: [],
      spouses: [],
      generation: 1,
      column: 0,
      events: events.length ? events : undefined,
    };
    const alternatives = names
      .slice(1)
      .filter((name) => name !== birthName)
      .map((name) => name.value)
      .filter(Boolean);
    if (alternatives.length) {
      p.biography = [p.biography, `Другие имена: ${alternatives.join("; ")}`]
        .filter(Boolean)
        .join("\n\n");
      warnings.add("Дополнительные имена сохранены в биографии.");
    }
    const extension = drevoExtra;
    if (extension) {
      try {
        const extra = JSON.parse(extension);
        stripArchiveSourceIds(extra.sources);
        for (const item of extra.events || []) {
          stripArchiveSourceIds(item.sources);
          stripArchiveSourceIds(item.placeClaim?.sources);
        }
        for (const key of [
          "name",
          "surname",
          "patronymic",
          "maidenName",
          "birth",
          "death",
          "birthPlace",
          "deathPlace",
          "birthLocation",
          "deathLocation",
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
        if (Object.hasOwn(extra, "sources"))
          restoreCitationMedia(p.sources, sources(n), "человека");
        if (Object.hasOwn(extra, "events")) {
          const eventNodes = n.children.filter((node) =>
            (Object.hasOwn(eventTags, node.tag) || ["BIRT", "DEAT"].includes(node.tag)) &&
            value(node, "_DREVO_EVENT_ID"));
          for (const item of p.events || []) {
            const matched = eventNodes.filter((node) =>
              value(node, "_DREVO_EVENT_ID") === item.id);
            const uniqueTarget = p.events?.filter((event) => event.id === item.id).length === 1;
            if (matched.length === 1 && uniqueTarget) {
              const node = matched[0];
              const general = children(node, "SOUR")
                .filter((source) => !value(source, "_DREVO_CLAIM"));
              restoreCitationMedia(item.sources,
                sources({ ...node, children: general }), `события ${item.id}`);
              if (item.placeClaim?.sources?.length) {
                const placeSources = children(node, "SOUR").filter((source) =>
                  value(source, "_DREVO_CLAIM") === "EVENT_PLACE");
                restoreCitationMedia(item.placeClaim.sources,
                  sources({ ...node, children: placeSources }), `места события ${item.id}`);
              }
            } else if ((item.sources?.length || item.placeClaim?.sources?.length) &&
              (!uniqueTarget || matched.length > 1 || n.children.some((node) =>
                children(node, "SOUR").some((source) => children(source, "OBJE").length))))
              warnings.add(`Событие ${item.id} не сопоставлено однозначно; связь с документом не перенесена.`);
          }
        }
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
          "SNOTE",
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
          "EXID",
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
    twinKind?: FamilyLink["twinKind"],
    evidence?: Source[],
  ) => {
    const existing = links.find(
      (l) =>
        l.type === type &&
        ((l.from === from && l.to === to) ||
          (type === "twin" && l.from === to && l.to === from)),
    );
    if (existing) {
      if (note) existing.note = note;
      if (type === "twin") existing.twinKind = twinKind || "unknown";
      if (evidence?.length) existing.sources = [...(existing.sources || []), ...evidence];
    } else
      links.push({
        id: `${namespace}-l${links.length + 1}`,
        from,
        to,
        type,
        note,
        ...(evidence?.length ? { sources: evidence } : {}),
        ...(type === "twin" ? { twinKind: twinKind || "unknown" } : {}),
      });
  };
  const unions: FamilyUnion[] = [];
  const families = roots.filter((n) => n.tag === "FAM");
  const restoreUnionCitationMedia = (target: Source[] | undefined, node: Node | undefined) => {
    if (node) restoreCitationMedia(target, sources(node), "союза");
  };
  for (const f of families) {
    for (const n of f.children)
      if (
        ![
          "HUSB",
          "WIFE",
          "CHIL",
          "_DREVO_PARENT",
          "_DREVO_UNMARRIED",
          "_DREVO_SPOUSE",
          "_DREVO_UNION",
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
    ]
      .filter((n) => n.value !== "@VOID@")
      .map((n) => personRef(n.value));
    const uniqueParents = [...new Map(parents.map((p) => [p.id, p])).values()];
    if (uniqueParents.length > 2)
      warnings.add(
        "Семьи с более чем двумя указанными родителями сохранены как записано; проверьте характер родства.",
      );
    const spousePair = uniqueParents.slice(0, 2);
    // A FAM record can describe parenthood or cohabitation without a marriage.
    // Only an explicit marriage (or its dissolution) establishes a spouse link.
    const marriageRecorded = ["MARR", "DIV", "DIVF", "ANUL"].some((tag) =>
      f.children.some((node) => node.tag === tag && node.value !== "N"),
    );
    if (
      spousePair.length === 2 &&
      value(f, "_DREVO_UNMARRIED") !== "Y" &&
      (marriageRecorded || value(f, "_DREVO_SPOUSE") === "Y")
    ) {
      for (const p of spousePair)
        p.spouses = [
          ...new Set([
            ...p.spouses,
            ...spousePair.filter((s) => s.id !== p.id).map((s) => s.id),
          ]),
        ];
    } else if (spousePair.length === 2 && value(f, "_DREVO_UNMARRIED") !== "Y")
      warnings.add(
        "У двух родителей не указано событие брака: связь супругов не создана. Проверьте её после импорта.",
      );
    if (spousePair.length === 2) {
      const explicit = value(f, "_DREVO_UNION");
      if (explicit) {
        let restored: FamilyUnion | undefined;
        try {
          restored = inlineUnionSources(JSON.parse(explicit) as FamilyUnion);
        } catch {
          warnings.add(
            "Запись семейного союза Drevo не прочитана; проверьте исходный GEDCOM.",
          );
        }
        if (restored) {
          restoreUnionCitationMedia(restored.sources, f);
          restoreUnionCitationMedia(restored.formation?.sources,
            f.children.find((node) => node.tag === "MARR") ||
            f.children.find((node) => node.tag === "EVEN" &&
              value(node, "_DREVO_UNION_STAGE") === "FORMATION"));
          restoreUnionCitationMedia(restored.divorce?.sources,
            f.children.find((node) => node.tag === "DIV"));
          restoreUnionCitationMedia(restored.ending?.sources,
            f.children.find((node) => node.tag === "EVEN" &&
              ["ENDING", ""].includes(value(node, "_DREVO_UNION_STAGE"))));
          restoreUnionCitationMedia(restored.ongoing?.sources,
            f.children.find((node) => node.tag === "EVEN" &&
              value(node, "_DREVO_UNION_STAGE") === "ONGOING"));
          unions.push({
            ...restored,
            participants: [spousePair[0].id, spousePair[1].id],
          });
        }
      } else if (marriageRecorded) {
        const milestone = (node: Node): UnionMilestone => {
          const item = event(node);
          return {
            date: item.date,
            dateText: item.dateText,
            place: item.place,
            sources: item.sources,
          };
        };
        const formation = f.children.find(
          (node) => node.tag === "MARR" && node.value !== "N",
        );
        const divorce = f.children.find(
          (node) =>
            ["DIV", "DIVF", "ANUL"].includes(node.tag) && node.value !== "N",
        );
        unions.push({
          id: `${namespace}-u${unions.length + 1}`,
          participants: [spousePair[0].id, spousePair[1].id],
          type: "marriage",
          ...(formation ? { formation: milestone(formation) } : {}),
          ...(divorce ? { divorce: milestone(divorce) } : {}),
          sources: sources(f),
          ...(notes(f) ? { note: notes(f) } : {}),
        });
      }
    }
    for (const c of children(f, "CHIL").filter((n) => n.value !== "@VOID@")) {
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
        else if (pedigree === "foster")
          addLink(p.id, person.id, "foster_parent");
        else person.parents = [...new Set([...person.parents, p.id])];
      }
    }
    for (const p of spousePair)
      if (
        !value(
          individuals.find((n) => ids.get(n.xref) === p.id)!,
          "_DREVO",
        )
      ) {
        p.sources.push(...sources(f));
        if (notes(f))
          p.biography = [p.biography, notes(f)].filter(Boolean).join("\n\n");
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
      const role = value(assoc, "ROLE");
      const type = (
        value(assoc, "RELA") ||
        (role === "GODP"
          ? "godparent"
          : child(assoc, "ROLE")
            ? value(child(assoc, "ROLE")!, "PHRASE")
            : "")
      ).toLowerCase() as FamilyLink["type"];
      if (assoc.value === "@VOID@") {
        warnings.add(
          "Связь ASSO с неизвестным участником сохранена только в исходном файле.",
        );
        continue;
      }
      if (EXTRA_LINK_TYPES.includes(type))
        addLink(
          personRef(assoc.value).id,
          ids.get(n.xref)!,
          type,
          notes(assoc) || undefined,
          type === "twin"
            ? ((value(assoc, "_DREVO_TWIN") ||
                "unknown") as FamilyLink["twinKind"])
            : undefined,
          sources(assoc),
        );
      else
        warnings.add(
          `Дополнительная связь «${type || "без типа"}» не перенесена автоматически.`,
        );
    }
    for (const ref of [...children(n, "FAMC"), ...children(n, "FAMS")]) {
      if (ref.value === "@VOID@") {
        warnings.add("В файле есть ссылки на неизвестную семью @VOID@.");
        continue;
      }
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
  const media: TransferMedia[] = [];
  const objects = new Map<Node, TransferMedia[]>();
  const readObject = (object: Node) => {
    const existing = objects.get(object);
    if (existing) return existing;
    const files = children(object, "FILE").map((file) => {
      const item: TransferMedia = {
        id: `${namespace}-m${media.length + 1}`,
        file: file.value,
        title: value(file, "TITL") || value(object, "TITL") || "Файл GEDCOM",
        mime: value(file, "FORM") || value(object, "FORM"),
        personIds: [],
        portraitIds: [],
        photo: { description: notes(object) || undefined, tags: [] },
      };
      const extension = value(object, "_DREVO_MEDIA");
      if (extension) {
        try {
          const extra = JSON.parse(extension);
          item.photo = {
            description: extra.description,
            year: extra.year,
            place: extra.place,
            event: extra.event,
            takenAt: extra.takenAt,
            tags: (extra.tags || []).map((tag: { personId: string }) => ({
              ...tag,
              personId: ids.get(tag.personId) || "",
            })),
          };
          item.portraitIds = (extra.portraitIds || [])
            .map((id: string) => ids.get(id))
            .filter(Boolean);
          if (extra.document !== undefined) {
            const document = parseDocumentDetails(extra.document);
            if (!document)
              throw new Error("Повреждены сведения о документе Drevo");
            item.document = document;
          }
        } catch {
          throw new Error("Повреждены сведения о медиа Drevo");
        }
      }
      media.push(item);
      return item;
    });
    objects.set(object, files);
    return files;
  };
  for (const object of roots.filter((n) => n.tag === "OBJE"))
    readObject(object);
  const retainedCitations = new Set<Source>();
  const retain = (sources?: Source[]) => {
    for (const source of sources || []) retainedCitations.add(source);
  };
  for (const person of people) {
    retain(person.sources);
    retain(person.birthDateClaim?.sources);
    retain(person.deathDateClaim?.sources);
    retain(person.birthPlaceClaim?.sources);
    retain(person.deathPlaceClaim?.sources);
    retain(person.occupationClaim?.sources);
    retain(person.maidenNameClaim?.sources);
    for (const event of person.events || []) {
      retain(event.sources);
      retain(event.placeClaim?.sources);
    }
  }
  for (const union of unions) {
    retain(union.sources);
    for (const stage of [union.formation, union.ending, union.divorce, union.ongoing])
      retain(stage?.sources);
  }
  for (const link of links) retain(link.sources);
  const citationMedia: NonNullable<GenealogyImport["citationMedia"]> = [];
  const citedImages = new Set<string>();
  for (const { source, object, page } of citationObjects) {
    if (!retainedCitations.has(source)) continue;
    const files = readObject(object);
    if (files.length > 1)
      warnings.add("У медиа цитаты несколько файлов; перенесён только первый документ.");
    const item = files[0];
    if (!item) continue;
    if (!item.document) {
      citedImages.add(item.id);
      item.document = { documentType: "", documentDate: "", place: "",
        description: "", provenance: "" };
    }
    citationMedia.push({ source, mediaId: item.id, page });
  }
  const attachMedia = (node: Node, personIds: string[]) => {
    for (const ref of children(node, "OBJE")) {
      if (ref.value === "@VOID@") continue;
      const object = ref.pointer ? records.get(ref.value) : ref;
      if (!object || object.tag !== "OBJE")
        throw new Error(`Не найдено медиа ${ref.value}`);
      for (const item of readObject(object)) {
        item.personIds = [...new Set([...item.personIds, ...personIds])];
        if (value(ref, "_PRIM") === "Y")
          item.portraitIds = [...new Set([...item.portraitIds, ...personIds])];
      }
    }
    for (const c of node.children.filter((c) => c.tag !== "OBJE" && c.tag !== "SOUR"))
      attachMedia(c, personIds);
  };
  for (const n of individuals) attachMedia(n, [ids.get(n.xref)!]);
  for (const f of families)
    attachMedia(
      f,
      [...children(f, "HUSB"), ...children(f, "WIFE"), ...children(f, "CHIL")]
        .filter((n) => n.value !== "@VOID@")
        .map((n) => personRef(n.value).id),
    );
  if (media.some((item) => citedImages.has(item.id) &&
    (item.personIds.length || item.portraitIds.length || item.photo?.tags.length)))
    warnings.add("Файл, указанный одновременно как фото и как документ цитаты, перенесён как документ; проверьте портрет и галерею после импорта.");
  if (media.length)
    warnings.add(
      "Файлы фотографий и документов не загружаются из GEDCOM. Добавьте оригиналы в галерею отдельно.",
    );
  for (const repository of roots.filter((node) => node.tag === "REPO"))
    if (repository.xref && !usedRepositories.has(repository.xref))
      warnings.add(`Запись REPO ${repository.xref} не связана с цитируемым источником и не перенесена.`);
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
      ...(unions.length ? { unions } : {}),
      photos: [],
    }),
    warnings: [...warnings],
    media,
    citationMedia,
    version,
  };
}

/** Стандартные записи + расширение _DREVO для точного обратного переноса наших полей. */
export function exportGedcom(
  family: Family,
  options: { version?: GedcomVersion; media?: TransferMedia[] } = {},
): string {
  const modern = options.version === "7.0";
  const media = options.media || familyMedia(family);
  const lines: string[] = [];
  function emit(level: number, tag: string, text = "", pointer = false) {
    if (
      [...text].some((c) => {
        const code = c.codePointAt(0)!;
        return (
          (code < 32 && ![9, 10, 13].includes(code)) ||
          (code >= 127 && code <= 159) ||
          (code >= 0xd800 && code <= 0xdfff) ||
          code === 0xfffe ||
          code === 0xffff
        );
      })
    )
      throw new Error("Текст содержит символы, недопустимые в GEDCOM");
    const parts = text.replace(/\r\n?/g, "\n").replace(/\0/g, "").split("\n");
    for (let i = 0; i < parts.length; i++) {
      let escaped = pointer
        ? parts[i]
        : modern
          ? parts[i].replace(/^@/, "@@")
          : parts[i].replace(/@/g, "@@");
      if (!modern && tag === "DATE")
        escaped = escaped.replace(/@@#D([^@]+)@@/g, "@#D$1@");
      if (modern) {
        lines.push(
          `${i ? level + 1 : level} ${i ? "CONT" : tag}${escaped ? ` ${escaped}` : ""}`,
        );
        continue;
      }
      const chars = escaped.match(/@@|[\s\S]/gu) || [];
      if (!chars.length)
        lines.push(`${i ? level + 1 : level} ${i ? "CONT" : tag}`);
      for (let start = 0; start < chars.length;) {
        let end = Math.min(start + 50, chars.length);
        // GEDCOM 5.5.1 requires CONC to split inside a word, not on a space:
        // several readers trim the start/end of physical lines.
        if (end < chars.length) {
          while (end > start && (chars[end] === " " || chars[end - 1] === " "))
            end--;
          if (end === start) {
            end = Math.min(start + 50, chars.length);
            while (
              end < chars.length &&
              (chars[end] === " " || chars[end - 1] === " ")
            )
              end++;
            if (
              new TextEncoder().encode(chars.slice(start, end).join(""))
                .length > 230
            )
              throw new Error(
                "Слишком длинная последовательность пробелов для GEDCOM 5.5.1. Используйте GEDCOM 7.",
              );
          }
        }
        lines.push(
          `${i || start ? level + 1 : level} ${start ? "CONC" : i ? "CONT" : tag} ${chars.slice(start, end).join("")}`,
        );
        start = end;
      }
    }
  }
  const ids = new Map(family.people.map((p, i) => [p.id, `@I${i + 1}@`]));
  const groups = new Map<
    string,
    {
      id: string;
      parents: string[];
      children: string[];
      married: boolean;
      pedigree: "birth" | "adopted" | "foster";
      union?: FamilyUnion;
    }
  >();
  function group(
    parents: string[],
    married = false,
    pedigree: "birth" | "adopted" | "foster" = "birth",
    union?: FamilyUnion,
  ) {
    const key = JSON.stringify([[...parents].sort(), pedigree, union?.id]);
    if (!groups.has(key))
      groups.set(key, {
        id: `@F${groups.size + 1}@`,
        parents: [...parents],
        children: [],
        married,
        pedigree,
        union,
      });
    const g = groups.get(key)!;
    g.married ||= married;
    return g;
  }
  for (const p of family.people) {
    if (p.parents.length) group(p.parents).children.push(p.id);
    for (const spouse of p.spouses) group([p.id, spouse], true);
  }
  for (const union of family.unions || [])
    group(union.participants, union.type === "marriage", "birth", union);
  for (const link of family.links || [])
    if (link.type === "adoptive_parent" || link.type === "foster_parent")
      group(
        [link.from],
        false,
        link.type === "adoptive_parent" ? "adopted" : "foster",
      ).children.push(link.to);
  const sourceRecords: Source[] = [];
  const documentMedia = new Map(media.flatMap((item, index) =>
    item.document ? [[item.id, `@M${index + 1}@`] as const] : []));
  function citation(level: number, source: Source,
    claim?: "BIRTH_DATE" | "DEATH_DATE" | "BIRTH_PLACE" | "DEATH_PLACE" | "OCCUPATION" | "BIRTH_SURNAME" | "EVENT_PLACE") {
    sourceRecords.push(source);
    emit(level, "SOUR", `@S${sourceRecords.length}@`, true);
    if (source.reference) emit(level + 1, "PAGE", source.reference);
    if (claim) emit(level + 1, "_DREVO_CLAIM", claim);
    const object = source.documentId
      ? documentMedia.get(source.documentId) : undefined;
    if (options.media && source.documentId && !object)
      throw new Error("Документ цитаты отсутствует в экспортируемых медиа GEDCOM");
    if (object) {
      emit(level + 1, "OBJE", object, true);
      if (source.documentPage)
        emit(level + 1, "_DREVO_DOCUMENT_PAGE", String(source.documentPage));
    }
  }
  function emitPlace(
    level: number,
    place: string | undefined,
    location?: PlaceLocation,
  ) {
    const name = place || location?.place;
    if (!name) return;
    emit(level, "PLAC", name);
    if (!location) return;
    const coordinate = (value: number, positive: string, negative: string) => {
      const degrees = Math.abs(value)
        .toFixed(12)
        .replace(/0+$/, "")
        .replace(/\.$/, "");
      return `${value < 0 ? negative : positive}${degrees}`;
    };
    emit(level + 1, "MAP");
    emit(level + 2, "LATI", coordinate(location.lat, "N", "S"));
    emit(level + 2, "LONG", coordinate(location.lon, "E", "W"));
  }
  emit(0, "HEAD");
  emit(1, "SOUR", "DREVO");
  emit(1, "GEDC");
  emit(2, "VERS", modern ? "7.0" : "5.5.1");
  if (!modern) {
    emit(2, "FORM", "LINEAGE-LINKED");
    emit(1, "CHAR", "UTF-8");
  } else {
    emit(1, "SCHMA");
    for (const tag of [
      "_DREVO",
      "_DREVO_PARENT",
      "_DREVO_UNMARRIED",
      "_DREVO_SPOUSE",
      "_DREVO_UNION",
      "_DREVO_MEDIA",
      "_DREVO_TWIN",
      "_DREVO_CLAIM",
      "_DREVO_DOCUMENT_PAGE",
      ...CLAIM_CONFIDENCE_TAGS,
      "_DREVO_UNION_STAGE",
      "_DREVO_EVENT_ID",
      "_TYPE",
      "_URL",
      "_PRIM",
    ])
      emit(
        2,
        "TAG",
        `${tag} https://drevo.kiiko.ru/gedcom/extensions/${tag.slice(1).toLowerCase()}`,
      );
  }
  emit(1, "SUBM", "@SUB1@", true);
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
    if (p.maidenName) {
      emit(
        1,
        "NAME",
        `${[p.name, p.patronymic].filter(Boolean).join(" ")} /${p.maidenName.replace(/\//g, " ")}/`,
      );
      emit(2, "TYPE", modern ? "BIRTH" : "birth");
      emit(2, "GIVN", [p.name, p.patronymic].filter(Boolean).join(" "));
      emit(2, "SURN", p.maidenName);
      for (const source of p.maidenNameClaim?.sources || [])
        citation(2, source, "BIRTH_SURNAME");
      if (p.maidenNameClaim?.confidence)
        emit(2, "_DREVO_BIRTH_SURNAME_CONFIDENCE", p.maidenNameClaim.confidence);
    }
    if (p.sex !== "u") emit(1, "SEX", p.sex.toUpperCase());
    const eventClaimsEmitted = { birth: false, death: false };
    const emitEventClaims = (kind: "birth" | "death") => {
      const dateClaim = kind === "birth" ? p.birthDateClaim : p.deathDateClaim;
      const placeClaim = kind === "birth" ? p.birthPlaceClaim : p.deathPlaceClaim;
      for (const source of dateClaim?.sources || [])
        citation(2, source, kind === "birth" ? "BIRTH_DATE" : "DEATH_DATE");
      if (dateClaim?.confidence) emit(2, "_DREVO_DATE_CONFIDENCE", dateClaim.confidence);
      for (const source of placeClaim?.sources || [])
        citation(2, source, kind === "birth" ? "BIRTH_PLACE" : "DEATH_PLACE");
      if (placeClaim?.confidence) emit(2, "_DREVO_PLACE_CONFIDENCE", placeClaim.confidence);
      eventClaimsEmitted[kind] = true;
    };
    for (const kind of ["birth", "death"] as const)
      if (
        !p.events?.some(
          (e) => e.gedcomTag === (kind === "birth" ? "BIRT" : "DEAT"),
        ) &&
        (p[kind] ||
          p[`${kind}Place`] ||
          p[`${kind}Location`] ||
          (kind === "death" && p.deceased))
      ) {
        emit(1, kind === "birth" ? "BIRT" : "DEAT", "Y");
        if (p[kind]) emit(2, "DATE", exportDate(p[kind]));
        emitPlace(2, p[`${kind}Place`], p[`${kind}Location`]);
        emitEventClaims(kind);
      }
    if (p.biography) emit(1, "NOTE", p.biography);
    const matchingOccupationEvent = p.events?.find((event) =>
      event.type === "work" && event.title === p.occupation &&
      (!event.gedcomTag || event.gedcomTag === "OCCU"));
    const emitOccupationClaim = () => {
      for (const source of p.occupationClaim?.sources || [])
        citation(2, source, "OCCUPATION");
      if (p.occupationClaim?.confidence)
        emit(2, "_DREVO_OCCUPATION_CONFIDENCE", p.occupationClaim.confidence);
    };
    if (p.occupation && (!p.events?.some((e) => e.type === "work" && e.title === p.occupation) ||
      (p.occupationClaim && !matchingOccupationEvent))) {
      emit(1, "OCCU", p.occupation);
      emitOccupationClaim();
    }
    for (const source of p.sources) citation(1, source);
    for (const original of p.events || []) {
      const kind =
        original.gedcomTag === "BIRT"
          ? "birth"
          : original.gedcomTag === "DEAT"
            ? "death"
            : undefined;
      // Editing the canonical birth/death fields must also update the standard
      // event, even when it originally came from an imported detailed event.
      const e = kind
        ? {
            ...original,
            date: p[kind] || undefined,
            endDate: undefined,
            dateText: p[kind] ? undefined : original.dateText,
            place: p[`${kind}Place`] || undefined,
            location:
              p[`${kind}Location`] ||
              (original.place === p[`${kind}Place`]
                ? original.location
                : undefined),
          }
        : original;
      const tag =
        e.gedcomTag &&
        [
          "BIRT",
          "DEAT",
          ...Object.keys(eventTags).filter(
            (tag) =>
              ![
                "MARR",
                "DIV",
                "ANUL",
                "DIVF",
                "ENGA",
                "MARB",
                "MARC",
                "MARL",
                "MARS",
                "_MILT",
              ].includes(tag),
          ),
        ].includes(e.gedcomTag)
          ? e.gedcomTag
          : (
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
        [
          "OCCU",
          "EDUC",
          "DSCR",
          "RELI",
          "NATI",
          "CAST",
          "PROP",
          "SSN",
          "IDNO",
          "NCHI",
          "NMR",
          "TITL",
          "FACT",
        ].includes(tag)
          ? e.title || EVENT_NAMES[e.type]
          : "",
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
      else if (e.dateText) {
        const date = portableDate(e.dateText, modern);
        emit(2, "DATE", date.date);
        if (date.phrase) emit(3, "PHRASE", date.phrase);
      } else if (e.endDate) emit(2, "DATE", `TO ${exportDate(e.endDate)}`);
      emitPlace(2, e.place, e.location);
      if (e.description) emit(2, "NOTE", e.description);
      for (const source of e.sources || []) citation(2, source);
      for (const source of e.placeClaim?.sources || []) citation(2, source, "EVENT_PLACE");
      if (original === matchingOccupationEvent) emitOccupationClaim();
      if (kind && !eventClaimsEmitted[kind]) emitEventClaims(kind);
      emit(2, "_DREVO_EVENT_ID", e.id);
    }
    for (const g of groups.values()) {
      if (g.children.includes(p.id)) {
        emit(1, "FAMC", g.id, true);
        emit(2, "PEDI", modern ? g.pedigree.toUpperCase() : g.pedigree);
      }
      if (g.parents.includes(p.id)) emit(1, "FAMS", g.id, true);
    }
    for (const l of family.links || [])
      if (l.to === p.id) {
        emit(1, "ASSO", ids.get(l.from)!, true);
        if (modern) {
          emit(2, "ROLE", l.type === "godparent" ? "GODP" : "OTHER");
          emit(3, "PHRASE", l.type);
        } else emit(2, "RELA", l.type);
        if (l.note) emit(2, "NOTE", l.note);
        if (l.type === "twin") emit(2, "_DREVO_TWIN", l.twinKind || "unknown");
        for (const source of l.sources || []) citation(2, source);
      }
    media.forEach((item, i) => {
      if (item.personIds.includes(p.id) || item.portraitIds.includes(p.id)) {
        emit(1, "OBJE", `@M${i + 1}@`, true);
        if (item.portraitIds.includes(p.id)) emit(2, "_PRIM", "Y");
      }
    });
    const {
      photo: _photo,
      createdBy: _createdBy,
      id: _id,
      parents: _parents,
      spouses: _spouses,
      generation: _generation,
      column: _column,
      birthDateClaim: _birthDateClaim,
      deathDateClaim: _deathDateClaim,
      birthPlaceClaim: _birthPlaceClaim,
      deathPlaceClaim: _deathPlaceClaim,
      occupationClaim: _occupationClaim,
      maidenNameClaim: _maidenNameClaim,
      ...extra
    } = p;
    void [_photo, _createdBy, _id, _parents, _spouses, _generation, _column,
      _birthDateClaim, _deathDateClaim, _birthPlaceClaim, _deathPlaceClaim,
      _occupationClaim, _maidenNameClaim];
    // The Drevo extension carries readable evidence, never archive-local source IDs.
    const portableExtra = structuredClone(extra);
    for (const source of portableExtra.sources || []) {
      delete source.catalogId;
      delete source.documentId;
      delete source.documentPage;
    }
    for (const event of portableExtra.events || []) {
      for (const source of event.sources || []) {
        delete source.catalogId;
        delete source.documentId;
        delete source.documentPage;
      }
      for (const source of event.placeClaim?.sources || []) {
        delete source.catalogId;
        delete source.documentId;
        delete source.documentPage;
      }
    }
    emit(1, "_DREVO", JSON.stringify(portableExtra));
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
      emit(1, role, ids.get(id)!, true);
      usedRoles.add(role);
    }
    if (g.union) {
      const { createdBy: _createdBy, ...portableUnion } = inlineUnionSources(g.union);
      void _createdBy;
      emit(1, "_DREVO_UNION", JSON.stringify(portableUnion));
      emit(1, "_DREVO_SPOUSE", "Y");
      const unionEvent = (
        tag: string,
        milestone: UnionMilestone | undefined,
        stage?: "FORMATION" | "ENDING" | "ONGOING",
      ) => {
        if (!milestone) return;
        emit(1, tag, "Y");
        if (stage) emit(2, "_DREVO_UNION_STAGE", stage);
        if (milestone.date) emit(2, "DATE", exportDate(milestone.date));
        else if (milestone.dateText) {
          const date = portableDate(milestone.dateText, modern);
          emit(2, "DATE", date.date);
          if (date.phrase) emit(3, "PHRASE", date.phrase);
        }
        emitPlace(2, milestone.place);
        for (const source of milestone.sources || []) citation(2, source);
      };
      if (g.union.type === "marriage")
        unionEvent("MARR", g.union.formation || {});
      else if (g.union.formation)
        unionEvent("EVEN", g.union.formation, "FORMATION");
      if (g.union.divorce) unionEvent("DIV", g.union.divorce);
      if (g.union.ending) unionEvent("EVEN", g.union.ending, "ENDING");
      if (g.union.ongoing) unionEvent("EVEN", g.union.ongoing, "ONGOING");
      if (g.union.note) emit(1, "NOTE", g.union.note);
      for (const source of g.union.sources || []) citation(1, source);
    } else if (!g.married) emit(1, "_DREVO_UNMARRIED", "Y");
    else emit(1, "_DREVO_SPOUSE", "Y");
    for (const id of g.children) emit(1, "CHIL", ids.get(id)!, true);
  }
  const repositoryRecords: NonNullable<Source["repository"]>[] = [];
  const repositoryIds = new Map<string, number>();
  function repositoryId(repository: NonNullable<Source["repository"]>): number {
    // CALN and linkNote describe this source's link to a repository, not the
    // repository record itself. They must not split a shared REPO record.
    const key = JSON.stringify([repository.name, repository.website, repository.note]);
    let id = repositoryIds.get(key);
    if (id === undefined) {
      id = repositoryRecords.push(repository);
      repositoryIds.set(key, id);
    }
    return id;
  }
  sourceRecords.forEach((s, i) => {
    emit(0, `@S${i + 1}@ SOUR`);
    emit(1, "TITL", s.title);
    if (s.type) emit(1, "_TYPE", s.type);
    if (s.url) {
      emit(1, "_URL", s.url);
      // SOURCE_RECORD has no standard URL field in either GEDCOM version.
      // A standard NOTE keeps the link visible in readers ignoring extensions.
      emit(1, "NOTE", `URL: ${s.url}`);
    }
    if (s.note) emit(1, "NOTE", s.note);
    if (s.repository) {
      emit(1, "REPO", `@R${repositoryId(s.repository)}@`, true);
      if (s.repository.callNumber) emit(2, "CALN", s.repository.callNumber);
      if (s.repository.linkNote) emit(2, "NOTE", s.repository.linkNote);
    }
  });
  repositoryRecords.forEach((repository, i) => {
    emit(0, `@R${i + 1}@ REPO`);
    emit(1, "NAME", repository.name);
    if (repository.website) emit(1, "WWW", repository.website);
    if (repository.note) emit(1, "NOTE", repository.note);
  });
  media.forEach((item, i) => {
    emit(0, `@M${i + 1}@ OBJE`);
    const path = item.file.startsWith("/media/")
      ? item.file.slice(1)
      : item.file;
    emit(1, "FILE", path);
    const extension = path.split(".").at(-1)?.toLowerCase() || "";
    const mime = item.mime?.includes("/")
      ? item.mime
      : (
          {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            pdf: "application/pdf",
          } as Record<string, string>
        )[extension] || "application/octet-stream";
    emit(2, "FORM", modern ? mime : mime.split("/")[1]);
    emit(2, "TITL", item.title);
    if (item.photo?.description) emit(1, "NOTE", item.photo.description);
    emit(
      1,
      "_DREVO_MEDIA",
      JSON.stringify({
        ...item.photo,
        tags: item.photo?.tags.map((tag) => ({
          ...tag,
          personId: ids.get(tag.personId),
        })),
        portraitIds: item.portraitIds.map((id) => ids.get(id)),
        document: item.document,
      }),
    );
  });
  emit(0, "TRLR");
  return lines.join("\r\n") + "\r\n";
}
