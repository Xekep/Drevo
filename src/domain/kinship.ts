import type { Person, Relation, KinshipRole, FamilyLink } from "./types.ts";
import { fullName, plural } from "./dates.ts";
import { resolvedSex } from "./name-hints.ts";
function unspecifiedRole(male: KinshipRole, female: KinshipRole): KinshipRole {
  return {
    term:
      male.term === female.term ? male.term : `${male.term} / ${female.term}`,
    description:
      male.description === female.description
        ? male.description
        : `${male.description} / ${female.description}`,
  };
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
  if (p.sex === "u")
    return distance === 1
      ? "родитель"
      : distance === 2
        ? "дедушка / бабушка"
        : `предок через ${distance} ${plural(distance, "поколение", "поколения", "поколений")}`;
  if (distance === 1) return p.sex === "m" ? "отец" : "мать";
  if (distance === 2) return p.sex === "m" ? "дедушка" : "бабушка";
  if (distance === 3) return p.sex === "m" ? "прадедушка" : "прабабушка";
  if (distance <= 6)
    return "пра".repeat(distance - 2) + (p.sex === "m" ? "дедушка" : "бабушка");
  return `предок через ${distance} ${plural(distance, "поколение", "поколения", "поколений")}`;
}
function descendantWord(p: Person, distance: number) {
  if (p.sex === "u")
    return distance === 1
      ? "ребёнок"
      : distance === 2
        ? "внук / внучка"
        : `потомок через ${distance} ${plural(distance, "поколение", "поколения", "поколений")}`;
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
  if (subject.sex === "u") {
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
    return unspecifiedRole(
      bloodRole({ ...subject, sex: "m" }, reference, ds, dr, map),
      bloodRole({ ...subject, sex: "f" }, reference, ds, dr, map),
    );
  }
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
    if (!parent || parent.sex === "u")
      return {
        term: sibling,
        description:
          "Указан общий родитель; сведений недостаточно, чтобы уточнить линию родства.",
      };
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
      ...(degree === 1 && ds < dr
        ? { aliases: [female ? "тётка" : "дядюшка"] }
        : {}),
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
  // Пол общего предка или самого адресата часто не влияет на название.
  const required: Record<string, number[]> = {
    S: [1],
    SU: [1, 2],
    DS: [1, 2],
    SUD: [1, 3],
    UDS: [2, 3],
    US: [1, 2],
    SD: [1, 2],
    USD: [3],
    DSU: [3],
    SUU: [1, 3],
    DDS: [2, 3],
    UUDS: [4],
    SUDD: [4],
    SUDS: [1, 3, 4],
    DU: [2],
  };
  if ((required[edges] || [path.length - 1]).some((i) => path[i].sex === "u")) {
    const neutral: Record<string, string> = {
      S: "супруг / супруга",
      SU: "родитель супруга",
      DS: "супруг ребёнка",
      SUD: "брат или сестра супруга",
      UDS: "супруг брата или сестры",
      US: "супруг родителя",
      SD: "ребёнок супруга",
      USD: "ребёнок супруга родителя",
      DSU: "родитель супруга ребёнка",
      SUU: "дедушка или бабушка супруга",
      DDS: "супруг внука или внучки",
      UUDS: "супруг дяди или тёти",
      SUDD: "племянник или племянница супруга",
      SUDS: "супруг брата или сестры супруга",
      DU: "родитель общего ребёнка",
    };
    return {
      term: neutral[edges] || "родственник через семью",
      description:
        "Связь подтверждена цепочкой в древе. Для точного названия укажите пол участников в их карточках.",
    };
  }
  const wife = female ? "жена" : "муж";
  if (edges === "UUDS")
    return {
      term: female ? "тётя по браку" : "дядя по браку",
      description: `${female ? "Жена дяди" : "Муж тёти"}. Связь через брак, а не общих предков.`,
    };
  if (edges === "SUDD")
    return {
      term: female ? "племянница по браку" : "племянник по браку",
      description: "Ребёнок брата или сестры супруга либо супруги.",
    };
  if (edges === "SUU")
    return {
      term: `${female ? "бабушка" : "дедушка"} ${path[1].sex === "m" ? "мужа" : "жены"}`,
      description: "Родитель одного из родителей супруга или супруги.",
    };
  if (edges === "DDS")
    return {
      term: `${wife} ${path[2].sex === "m" ? "внука" : "внучки"}`,
      description: "Супружеская связь в поколении внуков.",
    };
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
export function edgeLabel(from: Person, to: Person, links: FamilyLink[] = []) {
  to = { ...to, sex: resolvedSex(to) };
  if (to.sex === "u") {
    if (from.parents.includes(to.id)) return "родитель";
    if (to.parents.includes(from.id)) return "ребёнок";
    if (from.spouses.includes(to.id) || to.spouses.includes(from.id))
      return "супруг / супруга";
  }
  if (from.parents.includes(to.id)) return to.sex === "m" ? "отец" : "мать";
  if (to.parents.includes(from.id)) return to.sex === "m" ? "сын" : "дочь";
  if (from.spouses.includes(to.id) || to.spouses.includes(from.id))
    return to.sex === "m" ? "супруг" : "супруга";
  const link = links.find(
    (l) =>
      (l.from === from.id && l.to === to.id) ||
      (l.to === from.id && l.from === to.id),
  );
  if (link) return specialRole(link, to).term;
  return "семейная связь";
}
function analyzeBloodAndMarriage(
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
        explanation: `${older.name} — ${ancestorWord(older, d)}. ${younger.name} — ${descendantWord(younger, d)}.${marriageNote}`,
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
        a.sex === "u" || b.sex === "u"
          ? "Братья и сёстры"
          : a.sex === b.sex
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
      title =
        aunt.sex === "u" || child.sex === "u"
          ? "Родство дяди или тёти и племянника или племянницы"
          : `${aunt.sex === "m" ? "Дядя" : "Тётя"} и ${child.sex === "m" ? "племянник" : "племянница"}`;
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

function specialRole(link: FamilyLink, subject: Person): KinshipRole {
  if (subject.sex === "u")
    return unspecifiedRole(
      specialRole(link, { ...subject, sex: "m" }),
      specialRole(link, { ...subject, sex: "f" }),
    );
  const forward = link.from === subject.id,
    f = subject.sex === "f";
  switch (link.type) {
    case "adoptive_parent":
      return {
        term: forward
          ? f
            ? "приёмная мать"
            : "приёмный отец"
          : f
            ? "приёмная дочь"
            : "приёмный сын",
        description: "В архиве явно указано усыновление или удочерение.",
        aliases: [
          forward
            ? f
              ? "усыновительница"
              : "усыновитель"
            : f
              ? "удочерённая"
              : "усыновлённый",
        ],
      };
    case "godparent":
      return {
        term: forward
          ? f
            ? "крёстная мать"
            : "крёстный отец"
          : f
            ? "крестница"
            : "крестник",
        description: "Духовная связь, указанная в записи о крещении.",
      };
    case "nurse":
      return {
        term: forward
          ? "кормилица"
          : f
            ? "вскормленная девочка"
            : "вскормленный мальчик",
        description: "В архиве явно указана связь через вскармливание.",
      };
    case "sworn_sibling":
      return {
        term: f ? "названая сестра" : "названый брат",
        description:
          "Признанное братство; кровная связь из этой записи не следует.",
        ...(f ? {} : { aliases: ["побратим"] }),
      };
    case "guardian":
      return {
        term: forward
          ? f
            ? "опекунша"
            : "опекун"
          : f
            ? "подопечная"
            : "подопечный",
        description: "Указана опека. Это отдельная связь, не усыновление.",
      };
  }
}

export function analyzeKinship(
  a: Person,
  b: Person,
  people: Person[],
  links: FamilyLink[] = [],
): Relation {
  people = people.map((p) =>
    p.sex === "u" ? { ...p, sex: resolvedSex(p) } : p,
  );
  a = people.find((p) => p.id === a.id) || { ...a, sex: resolvedSex(a) };
  b = people.find((p) => p.id === b.id) || { ...b, sex: resolvedSex(b) };
  const base = analyzeBloodAndMarriage(a, b, people);
  if (a.id === b.id) return base;
  const extras: Relation[] = [];
  const add = (
    title: string,
    path: string[],
    roles: [KinshipRole, KinshipRole],
    explanation: string,
  ) =>
    extras.push({
      title,
      path,
      roles,
      explanation,
      common: [],
      kind: "family",
    });
  for (const link of links)
    if (
      (link.from === a.id && link.to === b.id) ||
      (link.from === b.id && link.to === a.id)
    ) {
      const roles: [KinshipRole, KinshipRole] = [
        specialRole(link, a),
        specialRole(link, b),
      ];
      add(
        roles[0].term[0].toUpperCase() + roles[0].term.slice(1),
        [a.id, b.id],
        roles,
        link.note || roles[0].description,
      );
    }
  const godChildren = (id: string) =>
    links
      .filter((l) => l.type === "godparent" && l.from === id)
      .map((l) => l.to);
  const ga = godChildren(a.id),
    gb = godChildren(b.id);
  const commonGodchild =
    ga.find(
      (id) =>
        gb.includes(id) ||
        people.find((p) => p.id === id)?.parents.includes(b.id),
    ) ||
    gb.find((id) => people.find((p) => p.id === id)?.parents.includes(a.id));
  if (commonGodchild)
    add(
      "Кумовство",
      [a.id, commonGodchild, b.id],
      [a, b].map((p) => ({
        term: p.sex === "u" ? "кум / кума" : p.sex === "m" ? "кум" : "кума",
        description:
          "Связь между родителями и крёстными одного ребёнка либо между его крёстными.",
      })) as [KinshipRole, KinshipRole],
      "Общая запись о крещении связывает этих людей.",
    );
  const nurses = (p: Person) =>
    new Set([
      ...p.parents,
      ...links
        .filter((l) => l.type === "nurse" && l.to === p.id)
        .map((l) => l.from),
    ]);
  const na = nurses(a),
    nb = nurses(b);
  const nurse = [...na].find(
    (id) =>
      nb.has(id) &&
      links.some(
        (l) =>
          l.type === "nurse" && l.from === id && [a.id, b.id].includes(l.to),
      ),
  );
  if (nurse)
    add(
      "Молочное родство",
      [a.id, nurse, b.id],
      [a, b].map((p) => ({
        term:
          p.sex === "u"
            ? "молочный брат / молочная сестра"
            : p.sex === "f"
              ? "молочная сестра"
              : "молочный брат",
        description:
          "Связь через одну кормилицу, подтверждённая архивной записью.",
      })) as [KinshipRole, KinshipRole],
      "Молочное родство учитывается отдельно от кровного.",
    );
  if (base.roles && base.distances?.[0] === 2 && base.distances[1] === 2)
    base.roles.forEach((r, i) => {
      if ([a, b][i].sex === "u") return;
      r.aliases = [
        i === 0
          ? a.sex === "m"
            ? "кузен"
            : "кузина"
          : b.sex === "m"
            ? "кузен"
            : "кузина",
      ];
    });
  if (base.kind !== "unknown")
    return { ...base, ...(extras.length ? { otherRelations: extras } : {}) };
  if (extras.length) return { ...extras[0], otherRelations: extras.slice(1) };
  // Keep adoption, spiritual and other documented paths visible without claiming blood kinship.
  const map = new Map(people.map((p) => [p.id, p])),
    seen = new Set([a.id]),
    queue = [[a.id]];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i],
      id = path[path.length - 1],
      p = map.get(id)!;
    const neighbors = new Set([
      ...p.parents,
      ...p.spouses,
      ...people
        .filter((x) => x.parents.includes(id) || x.spouses.includes(id))
        .map((x) => x.id),
      ...links
        .filter((l) => l.from === id || l.to === id)
        .map((l) => (l.from === id ? l.to : l.from)),
    ]);
    for (const next of neighbors) {
      if (seen.has(next) || !map.has(next)) continue;
      if (next === b.id)
        return {
          title: "Документированная семейная связь",
          explanation:
            "Цепочка включает усыновление, духовную или другую явно указанную связь. Она не означает кровного родства.",
          path: [...path, next],
          common: [],
          kind: "family",
        };
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return base;
}
