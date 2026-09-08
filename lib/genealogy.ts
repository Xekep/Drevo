export type Source = {
  title: string;
  type: string;
  reference: string;
  url?: string;
  note?: string;
};
export type Person = {
  id: string;
  surname: string;
  name: string;
  patronymic: string;
  sex: "m" | "f";
  birth: string;
  death?: string;
  birthPlace: string;
  deathPlace?: string;
  maidenName?: string;
  occupation?: string;
  biography?: string;
  photo?: string;
  parents: string[];
  /** True only when the complete parent list is known. */
  parentageComplete?: boolean;
  spouses: string[];
  generation: number;
  column: number;
  sources: Source[];
};
export type Family = {
  title: string;
  description: string;
  demo: boolean;
  people: Person[];
};
export type Relation = {
  title: string;
  explanation: string;
  path: string[];
  common: string[];
  kind: "direct" | "blood" | "marriage" | "family" | "unknown";
  distances?: [number, number];
  /** roles[0] describes the first selected person relative to the second. */
  roles?: [KinshipRole, KinshipRole];
};
export type KinshipRole = {
  term: string;
  description: string;
  aliases?: string[];
};
export const START_YEAR = 1830;
export const END_YEAR = 2035;
export const YEAR_HEIGHT = 8;
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 110;
export const RAIL_WIDTH = 92;
export const yearY = (year: number) => 60 + (year - START_YEAR) * YEAR_HEIGHT;
export const dateYear = (date?: string) =>
  date ? Number(date.slice(0, 4)) : new Date().getFullYear();
export const position = (p: Person) => ({
  x: 68 + p.column * 246,
  y: yearY(dateYear(p.birth)),
});
export const fullName = (p: Person) =>
  `${p.surname} ${p.name} ${p.patronymic}`.trim();
export const initials = (p: Person) =>
  `${p.name.trim()[0] || ""}${p.surname.trim()[0] || ""}` || "?";
export const years = (p: Person) =>
  `${dateYear(p.birth)} — ${p.death ? dateYear(p.death) : "н. в."}`;
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100,
    b = a % 10;
  return a > 10 && a < 20
    ? many
    : b === 1
      ? one
      : b >= 2 && b <= 4
        ? few
        : many;
}
export function dateLabel(value: string) {
  if (/^\d{4}$/.test(value)) return `${value} год`;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(new Date(value + "T12:00:00Z"))
    .replace(" г.", "");
}
export function ageLabel(p: Person) {
  const end = p.death || new Date().toISOString().slice(0, 10);
  const age =
    dateYear(end) -
    dateYear(p.birth) -
    (end.slice(5) < p.birth.slice(5) ? 1 : 0);
  return `${age} ${plural(age, "год", "года", "лет")}`;
}
export function safeUrl(value?: string): string | undefined {
  if (!value) return;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"))
    return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    /* Invalid URLs are omitted. */
  }
}
export function validateFamily(value: unknown): Family {
  if (!value || typeof value !== "object")
    throw new Error("Некорректный формат архива");
  const data = value as Family;
  if (
    typeof data.title !== "string" ||
    typeof data.description !== "string" ||
    typeof data.demo !== "boolean" ||
    !Array.isArray(data.people) ||
    !data.people.length
  )
    throw new Error("В архиве нет данных о людях");
  const ids = new Set<string>();
  const today = new Date().toISOString().slice(0, 10);
  const validDate = (s: unknown) =>
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  for (const p of data.people) {
    if (
      !p ||
      typeof p.id !== "string" ||
      !p.id ||
      ids.has(p.id) ||
      ![p.name, p.surname, p.patronymic, p.birthPlace].every(
        (s) => typeof s === "string",
      ) ||
      !["m", "f"].includes(p.sex) ||
      !validDate(p.birth) ||
      (p.death !== undefined && (!validDate(p.death) || p.death < p.birth)) ||
      !Array.isArray(p.parents) ||
      !Array.isArray(p.spouses) ||
      ![...p.parents, ...p.spouses].every((id) => typeof id === "string") ||
      !Number.isInteger(p.generation) ||
      p.generation < 1 ||
      !Number.isFinite(p.column) ||
      p.column < 0 ||
      !Array.isArray(p.sources)
    )
      throw new Error("Некорректная карточка человека");
    for (const key of [
      "deathPlace",
      "maidenName",
      "occupation",
      "biography",
      "photo",
    ] as const)
      if (p[key] !== undefined && typeof p[key] !== "string")
        throw new Error("Некорректные сведения о человеке");
    for (const s of p.sources)
      if (
        !s ||
        ![s.title, s.type, s.reference].every((v) => typeof v === "string") ||
        (s.url !== undefined && typeof s.url !== "string") ||
        (s.note !== undefined && typeof s.note !== "string")
      )
        throw new Error("Некорректный источник");
    ids.add(p.id);
    if (
      p.parentageComplete !== undefined &&
      typeof p.parentageComplete !== "boolean"
    )
      throw new Error("Некорректный признак полноты родительских сведений");
    if (
      !p.name.trim() ||
      !p.surname.trim() ||
      p.birth > today ||
      (p.death && p.death > today)
    )
      throw new Error("Проверьте имя и даты человека");
    if (
      new Set(p.parents).size !== p.parents.length ||
      new Set(p.spouses).size !== p.spouses.length
    )
      throw new Error("Семейная связь указана несколько раз");
  }
  const map = new Map(data.people.map((p) => [p.id, p]));
  for (const p of data.people) {
    if ([...p.parents, ...p.spouses].some((id) => !ids.has(id) || id === p.id))
      throw new Error("Обнаружена неизвестная семейная связь");
    if (p.parents.some((id) => map.get(id)!.birth >= p.birth))
      throw new Error("Родитель должен родиться раньше ребёнка");
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Error("В родительских связях найден цикл");
    if (visited.has(id)) return;
    active.add(id);
    map.get(id)!.parents.forEach(visit);
    active.delete(id);
    visited.add(id);
  }
  data.people.forEach((p) => visit(p.id));
  return data;
}

function ancestors(id: string, map: Map<string, Person>) {
  const paths = new Map<string, string[]>([[id, [id]]]);
  const queue = [id];
  for (let i = 0; i < queue.length; i++)
    for (const parent of map.get(queue[i])?.parents || []) {
      if (!paths.has(parent) && map.has(parent)) {
        paths.set(parent, [...paths.get(queue[i])!, parent]);
        queue.push(parent);
      }
    }
  return paths;
}
function ancestorWord(p: Person, distance: number) {
  if (distance === 1) return p.sex === "m" ? "отец" : "мать";
  if (distance === 2) return p.sex === "m" ? "дедушка" : "бабушка";
  if (distance === 3) return p.sex === "m" ? "прадедушка" : "прабабушка";
  if (distance <= 6)
    return "пра".repeat(distance - 2) + (p.sex === "m" ? "дедушка" : "бабушка");
  return `предок через ${distance} ${plural(distance, "поколение", "поколения", "поколений")}`;
}
function descendantWord(p: Person, distance: number) {
  if (distance === 1) return p.sex === "m" ? "сын" : "дочь";
  if (distance <= 6)
    return "пра".repeat(distance - 2) + (p.sex === "m" ? "внук" : "внучка");
  return `потомок через ${distance} поколений`;
}
function cousinAdjective(degree: number, female: boolean) {
  const stems: Record<number, string> = {
    2: "двоюродн",
    3: "троюродн",
    4: "четвероюродн",
    5: "пятиюродн",
    6: "шестиюродн",
    7: "семиюродн",
    8: "восьмиюродн",
    9: "девятиюродн",
    10: "десятиюродн",
  };
  return (stems[degree] || `${degree}-юродн`) + (female ? "ая" : "ый");
}
const completeParents = (p: Person) =>
  p.parentageComplete === true ||
  (p.parentageComplete !== false && p.parents.length >= 2);
function bloodRole(
  subject: Person,
  reference: Person,
  ds: number,
  dr: number,
  map: Map<string, Person>,
): KinshipRole {
  const female = subject.sex === "f",
    sibling = female ? "сестра" : "брат";
  if (ds === 0)
    return {
      term: ancestorWord(subject, dr),
      description: `Прямой предок: ${dr} ${plural(dr, "поколение", "поколения", "поколений")}.`,
    };
  if (dr === 0)
    return {
      term: descendantWord(subject, ds),
      description: `Прямой потомок: ${ds} ${plural(ds, "поколение", "поколения", "поколений")}.`,
    };
  if (ds === 1 && dr === 1) {
    const shared = [...new Set(subject.parents)].filter((id) =>
      reference.parents.includes(id),
    );
    if (shared.length >= 2)
      return completeParents(subject) && completeParents(reference)
        ? {
            term: `${female ? "родная" : "родной"} ${sibling}`,
            description: "В архиве указаны два общих родителя.",
            aliases: [female ? "полнородная сестра" : "полнородный брат"],
          }
        : {
            term: `${sibling} по указанным родителям`,
            description:
              "Есть общие родители, но сведения отмечены как неполные.",
          };
    const parent = map.get(shared[0]),
      father = parent?.sex === "m";
    const differentOtherParents =
      completeParents(subject) &&
      completeParents(reference) &&
      subject.parents.length >= 2 &&
      reference.parents.length >= 2;
    if (
      differentOtherParents &&
      [...subject.parents, ...reference.parents]
        .filter((id) => !shared.includes(id))
        .some((id) => map.get(id)?.sex !== (father ? "f" : "m"))
    )
      return {
        term: `${female ? "неполнородная" : "неполнородный"} ${sibling}`,
        description:
          "Один общий родитель; остальные указанные родители различаются.",
      };
    return differentOtherParents
      ? {
          term: `${father ? (female ? "единокровная" : "единокровный") : female ? "единоутробная" : "единоутробный"} ${sibling}`,
          description: father
            ? "Общий отец, разные матери."
            : "Общая мать, разные отцы.",
          aliases: [female ? "неполнородная сестра" : "неполнородный брат"],
        }
      : {
          term: `${sibling} по ${father ? "отцу" : "матери"}`,
          description: `Известен один общий родитель — ${parent ? fullName(parent) : "не указан"}. Сведений о втором родителе недостаточно, чтобы уточнить полнородность.`,
        };
  }
  if (ds === dr)
    return {
      term: `${cousinAdjective(ds, female)} ${sibling}`,
      description: `Ближайшие общие предки на ${ds} ${plural(ds, "поколение", "поколения", "поколений")} выше.`,
    };
  const degree = Math.min(ds, dr),
    difference = Math.abs(ds - dr);
  if (difference === 1) {
    const noun =
      ds < dr
        ? female
          ? "тётя"
          : "дядя"
        : female
          ? "племянница"
          : "племянник";
    const prefix = degree === 1 ? "" : `${cousinAdjective(degree, female)} `;
    return {
      term: prefix + noun,
      description:
        ds < dr
          ? `${degree === 1 ? "Родственник" : "Двоюродный или более дальний родственник"} в поколении родителей; разница — одно поколение.`
          : "Потомок боковой ветви; разница — одно поколение.",
    };
  }
  if (degree === 1 && difference === 2)
    return ds < dr
      ? {
          term: `двоюродн${female ? "ая бабушка" : "ый дедушка"}`,
          description: `${female ? "Сестра" : "Брат"} дедушки или бабушки.`,
        }
      : {
          term: `внучат${female ? "ая племянница" : "ый племянник"}`,
          description: `${female ? "Внучка" : "Внук"} брата или сестры.`,
        };
  return {
    term:
      ds < dr
        ? `${degree === 1 ? sibling : `${cousinAdjective(degree, female)} ${sibling}`} предка`
        : "потомок боковой ветви",
    description: `Разница — ${difference} ${plural(difference, "поколение", "поколения", "поколений")}; от общего предка: ${ds} и ${dr}.`,
  };
}

/** Interpret an actual path from reference to subject; never infer marriage from co-parenting. */
function familyRole(path: Person[]): KinshipRole {
  const subject = path[path.length - 1],
    female = subject.sex === "f";
  const edges = path
    .slice(1)
    .map((p, i) =>
      path[i].spouses.includes(p.id) || p.spouses.includes(path[i].id)
        ? "S"
        : path[i].parents.includes(p.id)
          ? "U"
          : "D",
    )
    .join("");
  const wife = female ? "жена" : "муж";
  if (edges === "S")
    return {
      term: female ? "жена" : "муж",
      description: "В архиве указан брак.",
      aliases: [female ? "супруга" : "супруг"],
    };
  if (edges === "SU") {
    const husband = path[1].sex === "m";
    return {
      term: husband
        ? female
          ? "свекровь"
          : "свёкор"
        : female
          ? "тёща"
          : "тесть",
      description: `${female ? "Мать" : "Отец"} ${husband ? "мужа" : "жены"}.`,
    };
  }
  if (edges === "DS") {
    const son = path[1].sex === "m";
    return {
      term:
        female && son
          ? "невестка"
          : !female && !son
            ? "зять"
            : `${wife} ${son ? "сына" : "дочери"}`,
      description: `${female ? "Жена" : "Муж"} ${son ? "сына" : "дочери"}.`,
      ...(female && son ? { aliases: ["сноха"] } : {}),
    };
  }
  if (edges === "SUD") {
    const husband = path[1].sex === "m";
    return {
      term: husband
        ? female
          ? "золовка"
          : "деверь"
        : female
          ? "свояченица"
          : "шурин",
      description: `${female ? "Сестра" : "Брат"} ${husband ? "мужа" : "жены"}. Родство брата или сестры подтверждается указанным общим родителем.`,
    };
  }
  if (edges === "UDS") {
    const brother = path[2].sex === "m";
    return {
      term:
        female && brother
          ? "невестка"
          : !female && !brother
            ? "зять"
            : `${wife} ${brother ? "брата" : "сестры"}`,
      description: `${female ? "Жена" : "Муж"} ${brother ? "брата" : "сестры"}.`,
    };
  }
  const complete = (p: Person) =>
    p.parentageComplete === true ||
    (p.parentageComplete !== false && p.parents.length >= 2);
  if (edges === "US")
    return {
      term:
        complete(path[0]) && path[1].sex !== subject.sex
          ? female
            ? "мачеха"
            : "отчим"
          : `${wife} ${path[1].sex === "m" ? "отца" : "матери"}`,
      description: complete(path[0])
        ? "Супруг или супруга родителя по указанному браку; не входит в полный список родителей."
        : "Список родителей неполный: пока нельзя уверенно назвать этого человека отчимом или мачехой.",
    };
  if (edges === "SD")
    return {
      term: complete(subject)
        ? female
          ? "падчерица"
          : "пасынок"
        : `${female ? "дочь" : "сын"} ${path[1].sex === "m" ? "мужа" : "жены"}`,
      description: complete(subject)
        ? "Ребёнок супруга или супруги. Полный список родителей известен; собственной родительской связи нет."
        : "Родительские сведения неполные: связь пасынка или падчерицы не подтверждена.",
    };
  if (edges === "USD")
    return {
      term:
        complete(path[0]) && complete(subject)
          ? female
            ? "сводная сестра"
            : "сводный брат"
          : "ребёнок супруга родителя",
      description:
        complete(path[0]) && complete(subject)
          ? "Их родители связаны браком; оба списка родителей известны, общих родителей нет."
          : "Родители связаны браком, но для вывода о сводном родстве нужно уточнить оба списка родителей.",
    };
  if (edges === "DSU")
    return {
      term: female ? "сватья" : "сват",
      description: `${female ? "Мать" : "Отец"} супруга или супруги ребёнка.`,
    };
  if (edges === "SUDS") {
    const referenceSpouse = path[1],
      subjectSpouse = path[3];
    if (!female && referenceSpouse.sex === "f" && subjectSpouse.sex === "f")
      return { term: "свояк", description: "Муж сестры жены." };
    if (female && subjectSpouse.sex === "m")
      return {
        term: "невестка",
        description:
          referenceSpouse.sex === "m" ? "Жена брата мужа." : "Жена брата жены.",
        ...(referenceSpouse.sex === "m"
          ? { aliases: ["ятровка (устар.)"] }
          : {}),
      };
    if (!female && referenceSpouse.sex === "m" && subjectSpouse.sex === "f")
      return { term: "зять", description: "Муж сестры мужа." };
  }
  if (edges === "DU")
    return {
      term: female ? "мать общего ребёнка" : "отец общего ребёнка",
      description: "Указан общий ребёнок; наличие брака из этого не следует.",
    };
  return {
    term: "родственник через семью",
    description:
      "Связь раскрыта в цепочке ниже; для неё не выбран отдельный бытовой термин.",
  };
}
export function edgeLabel(from: Person, to: Person) {
  if (from.parents.includes(to.id)) return to.sex === "m" ? "отец" : "мать";
  if (to.parents.includes(from.id)) return to.sex === "m" ? "сын" : "дочь";
  if (from.spouses.includes(to.id) || to.spouses.includes(from.id))
    return to.sex === "m" ? "супруг" : "супруга";
  return "семейная связь";
}
export function analyzeKinship(
  a: Person,
  b: Person,
  people: Person[],
): Relation {
  const map = new Map(people.map((p) => [p.id, p]));
  if (a.id === b.id)
    return {
      title: "Один и тот же человек",
      explanation: "Выберите двух разных людей.",
      path: [a.id],
      common: [],
      kind: "unknown",
    };
  const ap = ancestors(a.id, map),
    bp = ancestors(b.id, map);
  const spouse = a.spouses.includes(b.id) || b.spouses.includes(a.id);
  const common = [...ap.keys()]
    .filter((id) => bp.has(id))
    .sort(
      (x, y) =>
        ap.get(x)!.length +
        bp.get(x)!.length -
        (ap.get(y)!.length + bp.get(y)!.length),
    );
  if (common.length) {
    // Direct ancestry takes priority even when a pedigree contains multiple paths.
    const nearest = bp.has(a.id) ? a.id : ap.has(b.id) ? b.id : common[0],
      pa = ap.get(nearest)!,
      pb = bp.get(nearest)!;
    const da = pa.length - 1,
      db = pb.length - 1;
    const equivalent = common.filter(
      (id) =>
        ap.get(id)!.length === pa.length && bp.get(id)!.length === pb.length,
    );
    const path = [...pa, ...pb.slice(0, -1).reverse()];
    const marriageNote = spouse ? " Также в архиве указан их брак." : "";
    const roles: [KinshipRole, KinshipRole] = [
      bloodRole(a, b, da, db, map),
      bloodRole(b, a, db, da, map),
    ];
    if (da === 0 || db === 0) {
      const older = da === 0 ? a : b,
        younger = da === 0 ? b : a,
        d = Math.max(da, db);
      return {
        title: "Прямая линия родства",
        explanation: `${older.name} — ${ancestorWord(older, d)}. ${younger.name} — ${d === 1 ? (younger.sex === "m" ? "сын" : "дочь") : d === 2 ? (younger.sex === "m" ? "внук" : "внучка") : d === 3 ? (younger.sex === "m" ? "правнук" : "правнучка") : `потомок через ${d} поколений`}.${marriageNote}`,
        path,
        common: [older.id],
        kind: "direct",
        distances: [da, db],
        roles,
      };
    }
    let title = "Боковое родство";
    if (da === 1 && db === 1) {
      title =
        a.sex === b.sex
          ? a.sex === "m"
            ? "Братья"
            : "Сёстры"
          : "Брат и сестра";
      const shared = a.parents.filter((id) => b.parents.includes(id));
      if (
        shared.length === 1 &&
        a.parents.length >= 2 &&
        b.parents.length >= 2 &&
        completeParents(a) &&
        completeParents(b)
      )
        title = "Неполнородные " + title.toLowerCase();
    } else if (Math.min(da, db) === 1 && Math.max(da, db) === 2) {
      const aunt = da === 1 ? a : b,
        child = da === 1 ? b : a;
      title = `${aunt.sex === "m" ? "Дядя" : "Тётя"} и ${child.sex === "m" ? "племянник" : "племянница"}`;
    } else if (da === db)
      title =
        da === 2
          ? "Двоюродное родство"
          : da === 3
            ? "Троюродное родство"
            : `Родство в ${da}-м колене`;
    return {
      title,
      explanation: `Общий предок — ${fullName(map.get(nearest)!)}. От ${a.name}: ${da} ${plural(da, "поколение", "поколения", "поколений")}, от ${b.name}: ${db} ${plural(db, "поколение", "поколения", "поколений")}.${marriageNote}`,
      path,
      common: equivalent,
      kind: "blood",
      distances: [da, db],
      roles,
    };
  }
  if (spouse)
    return {
      title: "Супруги",
      explanation: `${a.name} и ${b.name} связаны браком, указанным в семейном архиве.`,
      path: [a.id, b.id],
      common: [],
      kind: "marriage",
      roles: [familyRole([b, a]), familyRole([a, b])],
    };
  const seen = new Set([a.id]),
    queue: string[][] = [[a.id]];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i],
      last = map.get(path[path.length - 1])!;
    const neighbors = new Set([
      ...last.parents,
      ...last.spouses,
      ...people
        .filter(
          (p) => p.parents.includes(last.id) || p.spouses.includes(last.id),
        )
        .map((p) => p.id),
    ]);
    for (const id of neighbors) {
      if (seen.has(id) || !map.has(id)) continue;
      const next = [...path, id];
      if (id === b.id) {
        const nodes = next.map((item) => map.get(item)!);
        const roles: [KinshipRole, KinshipRole] = [
          familyRole([...nodes].reverse()),
          familyRole(nodes),
        ];
        const named = roles.every(
          (role) => role.term !== "родственник через семью",
        );
        const samePlural: Record<string, string> = {
          "сводный брат": "Сводные братья",
          "сводная сестра": "Сводные сёстры",
          свояк: "Свояки",
          невестка: "Невестки",
          сват: "Сваты",
          сватья: "Сватьи",
        };
        const title = !named
          ? "Связь через семью"
          : roles[0].term === roles[1].term
            ? samePlural[roles[0].term] || roles[0].term
            : `${roles[0].term} и ${roles[1].term}`;
        const hasMarriage = next.some(
          (item, j) =>
            j > 0 &&
            (map.get(item)!.spouses.includes(next[j - 1]) ||
              map.get(next[j - 1])!.spouses.includes(item)),
        );
        return {
          title: title[0].toLocaleUpperCase("ru") + title.slice(1),
          explanation: `${hasMarriage ? "Цепочка включает супружеские связи." : "Людей связывает семейная цепочка через общих потомков; брак не указан."} Общий предок в имеющихся данных не найден.`,
          path: next,
          common: [],
          kind: "family",
          roles,
        };
      }
      seen.add(id);
      queue.push(next);
    }
  }
  return {
    title: "Связь пока не найдена",
    explanation:
      "В имеющихся данных недостаточно связей. Это не означает, что люди не родственники.",
    path: [],
    common: [],
    kind: "unknown",
  };
}

export const ERAS = [
  {
    name: "Российская империя",
    short: "Империя",
    start: 1721,
    end: 1917,
    color: "#b6b79b",
    className: "empire",
  },
  {
    name: "Революция и РСФСР",
    short: "1917–1922",
    start: 1917,
    end: 1922,
    color: "#b8a495",
    className: "transition",
  },
  {
    name: "Советский Союз",
    short: "СССР",
    start: 1922,
    end: 1991,
    color: "#b5a18e",
    className: "soviet",
  },
  {
    name: "Россия",
    short: "Россия",
    start: 1991,
    end: 2100,
    color: "#89a293",
    className: "russia",
  },
];
