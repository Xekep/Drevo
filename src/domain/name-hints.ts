import type { Person, FamilyLink } from "./types.ts";
import { dateBound as bound } from "./dates.ts";

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е");
const maleNames = new Set(
  "александр алексей анатолий андрей антон аркадий арсений артем борис вадим валентин валерий василий виктор виталий владимир владислав вячеслав гавриил геннадий георгий герман глеб григорий данил данила даниил денис дмитрий евгений егор иван игорь илья кирилл константин кузьма лев леонид лука максим марк матвей михаил никита николай олег павел петр роман ростислав савва семен сергей станислав степан тимофей федор филипп фома эдуард юрий яков ярослав".split(
    " ",
  ),
);
const femaleNames = new Set(
  "александра алла алина алиса анастасия ангелина анна антонина валентина валерия варвара вера вероника виктория галина дарья диана евгения евдокия екатерина елена елизавета зинаида зоя инна ирина клавдия ксения лариса лидия любовь людмила маргарита марина мария надежда наталия наталья нина оксана ольга полина раиса светлана софия софья таисия тамара татьяна ульяна юлия".split(
    " ",
  ),
);

for (const name of "авдей авраам адам аким альберт антип аполлон аристарх архип афанасий богдан валерьян вениамин викентий виссарион всеволод гордей демид демьян добрыня ефим ефрем захар игнат игнатий иннокентий ипполит карп клим лаврентий лазарь леонтий макар марат мирон мирослав митрофан наум назар нестор никифор никон остап панкрат платон прохор радомир родион руслан савелий самуил святослав серафим тихон трифон фаддей федот фрол харитон эрнест юлиан юлий".split(
  " ",
))
  maleNames.add(name);
for (const name of "августа агата агния аграфена аделина алена алевтина анфиса василиса виолетта ева есения ефросинья жанна ия калерия карина кристина лилия майя марфа милана милада неонила пелагея прасковья регина римма серафима стефания уляна фаина федора фекла харитина эвелина эльвира эмма яна ярослава".split(
  " ",
))
  femaleNames.add(name);
for (const name of "артемий артур влас давид елисей зиновий иосиф осип моисей онисим тарас тимур трофим эмиль роберт генрих".split(
  " ",
))
  maleNames.add(name);
for (const name of "арина аксинья альбина анжела глафира инга матрона матрена нонна олеся устинья".split(
  " ",
))
  femaleNames.add(name);

/** Подсказка по полному имени/отчеству. Фамилия сама по себе не определяет пол. */
export function guessSex(
  p: Pick<Person, "name" | "patronymic">,
): Person["sex"] {
  const name = normalize(p.name),
    patronymic = normalize(p.patronymic);
  const byName = maleNames.has(name) ? "m" : femaleNames.has(name) ? "f" : "u";
  const byPatronymic = /(?:ович|евич|ич)$/.test(patronymic)
    ? "m"
    : /(?:овна|евна|ична|инична)$/.test(patronymic)
      ? "f"
      : "u";
  if (byName !== "u" && byPatronymic !== "u" && byName !== byPatronymic)
    return "u";
  return byPatronymic !== "u" ? byPatronymic : byName;
}
export const resolvedSex = (p: Pick<Person, "sex" | "name" | "patronymic">) =>
  p.sex === "u" ? guessSex(p) : p.sex;

/** Ограниченный словарь исключений; неизвестные формы не достраиваем догадкой. */
const irregular: Record<string, string[]> = {
  дмитрий: ["дмитриевич", "дмитриевна"],
  юрий: ["юрьевич", "юрьевна"],
  василий: ["васильевич", "васильевна"],
  григорий: ["григорьевич", "григорьевна"],
  георгий: ["георгиевич", "георгиевна"],
  павел: ["павлович", "павловна"],
  петр: ["петрович", "петровна"],
  лев: ["львович", "львовна"],
  илья: ["ильич", "ильинична"],
  никита: ["никитич", "никитична", "никитович", "никитовна"],
  савва: ["саввич", "саввична"],
  лука: ["лукич", "лукинична"],
  кузьма: ["кузьмич", "кузьминична"],
  фома: ["фомич", "фоминична"],
  яков: ["яковлевич", "яковлевна"],
  данил: ["данилович", "даниловна"],
  данила: ["данилович", "даниловна"],
  даниил: ["даниилович", "данииловна", "данилович", "даниловна"],
  гавриил: ["гавриилович", "гаврииловна", "гаврилович", "гавриловна"],
};
export function matchesPatronymic(fatherName: string, patronymic: string) {
  const name = normalize(fatherName),
    value = normalize(patronymic);
  if (
    !name ||
    !value ||
    !/^[а-я]+$/.test(name) ||
    ["саша", "женя", "валя", "паша"].includes(name)
  )
    return false;
  if (irregular[name]) return irregular[name].includes(value);
  if (/[ая]$/.test(name)) return false;
  const stems = name.endsWith("ий")
    ? [name.slice(0, -2) + "ь", name.slice(0, -1)]
    : /[йь]$/.test(name)
      ? [name.slice(0, -1)]
      : [name];
  return stems.some((stem) =>
    (/[йь]$/.test(name) ? ["евич", "евна"] : ["ович", "овна"]).some(
      (suffix) => value === stem + suffix,
    ),
  );
}

/** Двойную фамилию преобразуем, только когда понятна каждая её часть. */
export function surnameForSex(
  surname: string,
  sex: Person["sex"],
): string | null {
  if (sex === "u") return null;
  const value = surname
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "")
    .trim()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s*-\s*/g, "-");
  if (/\s/.test(value)) return null;
  if (value.includes("-")) {
    const parts = value.split("-").map((part) => surnameForSex(part, sex));
    return parts.every(Boolean) ? parts.join("-") : null;
  }
  if (sex === "f") {
    if (/(ова|ева|ёва|ина|ына|ская|цкая)$/i.test(value)) return value;
    if (/(ов|ев|ёв|ин|ын)$/i.test(value)) return value + "а";
    if (/ский$/i.test(value)) return value.slice(0, -4) + "ская";
    if (/цкий$/i.test(value)) return value.slice(0, -4) + "цкая";
  } else {
    if (/(ов|ев|ёв|ин|ын|ский|цкий)$/i.test(value)) return value;
    if (/(ова|ева|ёва|ина|ына)$/i.test(value)) return value.slice(0, -1);
    if (/ская$/i.test(value)) return value.slice(0, -4) + "ский";
    if (/цкая$/i.test(value)) return value.slice(0, -4) + "цкий";
  }
  if (/(енко|ко|ич|ых|их)$/i.test(value)) return value;
  return null;
}
function surnameKeys(p: Person) {
  return new Set(
    [p.surname, p.maidenName || ""]
      .filter((value) => value.trim())
      .map((value) => normalize(surnameForSex(value, "m") || value)),
  );
}
const surnameMatch = (a: Person, b: Person) => {
  const aKeys = surnameKeys(a),
    bKeys = surnameKeys(b);
  if (![...aKeys].some((key) => bKeys.has(key))) return 0;
  const birthKey = (p: Person) =>
    normalize(surnameForSex(p.maidenName || "", "m") || p.maidenName || "");
  return (a.maidenName && bKeys.has(birthKey(a))) ||
    (b.maidenName && aKeys.has(birthKey(b)))
    ? 2
    : 1;
};
export type ParentHint = {
  from: string;
  to: string;
  person: Person;
  role: "father" | "mother" | "child";
  parentSex: "m" | "f";
  reason: string;
};
export function parentHints(
  draft: Person,
  people: Person[],
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
): ParentHint[] {
  const all = new Map(
    people.filter((p) => p.id !== draft.id).map((p) => [p.id, p]),
  );
  all.set(draft.id, draft);
  const hints: ParentHint[] = [];
  const parentGraph = new Map([...all].map(([id, p]) => [id, [...p.parents]]));
  for (const link of links)
    if (link.type === "adoptive_parent")
      parentGraph.get(link.to)?.push(link.from);
  const ancestors = (id: string) => {
    const seen = new Set<string>(),
      queue = [...(parentGraph.get(id) || [])];
    for (let i = 0; i < queue.length; i++) {
      if (seen.has(queue[i])) continue;
      seen.add(queue[i]);
      queue.push(...(parentGraph.get(queue[i]) || []));
    }
    return seen;
  };
  const draftAncestors = ancestors(draft.id);
  function plausible(father: Person, child: Person, sex: "m" | "f") {
    if (
      father.id === child.id ||
      resolvedSex(father) !== sex ||
      child.parents.includes(father.id) ||
      father.spouses.includes(child.id) ||
      child.spouses.includes(father.id)
    )
      return false;
    if (
      child.parentageComplete === true ||
      child.parents.length >= 2 ||
      child.parents.some((id) => {
        const p = all.get(id);
        return p && resolvedSex(p) === sex;
      })
    )
      return false;
    const birth = child.birth ? Number(child.birth.slice(0, 4)) : null;
    const parentBirth = father.birth ? Number(father.birth.slice(0, 4)) : null;
    if (
      birth !== null &&
      parentBirth !== null &&
      (birth - parentBirth < 14 ||
        birth - parentBirth > (sex === "m" ? 75 : 55))
    )
      return false;
    if (
      birth !== null &&
      father.death &&
      Number(father.death.slice(0, 4)) < birth - (sex === "m" ? 1 : 0)
    )
      return false;
    const later = (date: string, years: number) =>
      `${String(Number(date.slice(0, 4)) + years).padStart(4, "0")}${date.slice(4)}`;
    if (
      father.death &&
      child.birth &&
      later(bound(father.death, true), sex === "m" ? 1 : 0) <
        bound(child.birth, false)
    )
      return false;
    if (
      father.birth &&
      (child.birth || child.death) &&
      later(bound(father.birth, false), 14) >
        bound(child.birth || child.death!, true)
    )
      return false;
    if (
      parentBirth !== null &&
      child.death &&
      Number(child.death.slice(0, 4)) - parentBirth < 14
    )
      return false;
    if (father.parents.some((id) => child.parents.includes(id))) return false;
    const parentAncestors =
      father.id === draft.id ? draftAncestors : ancestors(father.id);
    const childAncestors =
      child.id === draft.id ? draftAncestors : ancestors(child.id);
    if (parentAncestors.has(child.id) || childAncestors.has(father.id))
      return false;
    return true;
  }
  for (const p of people) {
    for (const [father, child, role] of [
      [p, draft, "father"],
      [draft, p, "child"],
    ] as const) {
      if (
        !matchesPatronymic(father.name, child.patronymic) ||
        !plausible(father, child, "m")
      )
        continue;
      hints.push({
        from: father.id,
        to: child.id,
        person: p,
        role,
        parentSex: "m",
        reason: `Имя ${father.name} соответствует отчеству ${child.patronymic}${surnameMatch(father, child) === 2 ? "; совпадает фамилия при рождении" : surnameMatch(father, child) ? "; совпадает фамилия" : ""}. Совпадение ФИО само по себе не доказывает родство.`,
      });
    }
  }
  // Общие дети — более сильное основание; брак даёт только вопрос для проверки.
  const coparents = new Map<string, Map<string, Person>>();
  for (const sibling of all.values())
    for (const fatherId of sibling.parents) {
      const father = all.get(fatherId);
      if (!father || resolvedSex(father) !== "m") continue;
      for (const motherId of sibling.parents) {
        const mother = all.get(motherId);
        if (!mother || resolvedSex(mother) !== "f") continue;
        const mothers = coparents.get(fatherId) || new Map<string, Person>();
        mothers.set(motherId, sibling);
        coparents.set(fatherId, mothers);
      }
    }
  for (const child of all.values()) {
    if (child.id !== draft.id && resolvedSex(draft) !== "f") continue;
    for (const fatherId of child.parents) {
      const father = all.get(fatherId);
      if (!father) continue;
      if (resolvedSex(father) !== "m") continue;
      const candidates = new Set([
        ...(coparents.get(fatherId)?.keys() || []),
        ...father.spouses,
      ]);
      for (const motherId of candidates) {
        const mother = all.get(motherId),
          sibling = coparents.get(fatherId)?.get(motherId);
        if (!mother) continue;
        if (child.id !== draft.id && mother.id !== draft.id) continue;
        if (!plausible(mother, child, "f")) continue;
        hints.push({
          from: mother.id,
          to: child.id,
          person: child.id === draft.id ? mother : child,
          role: child.id === draft.id ? "mother" : "child",
          parentSex: "f",
          reason: sibling
            ? `У ${mother.name} и указанного отца ${father.name} уже записан общий ребёнок: ${sibling.name}. Уточните, одна ли это мать: дети могут быть единокровными.`
            : `${mother.name} указана супругой отца ${father.name}. Проверьте, мать ли она этому ребёнку: супруга отца может быть мачехой.`,
        });
      }
    }
  }
  const unique = [
    ...new Map(hints.map((hint) => [`${hint.from}:${hint.to}`, hint])).values(),
  ];
  return unique.sort(
    (a, b) =>
      surnameMatch(b.person, draft) - surnameMatch(a.person, draft) ||
      a.person.surname.localeCompare(b.person.surname, "ru") ||
      a.person.name.localeCompare(b.person.name, "ru") ||
      a.person.id.localeCompare(b.person.id),
  );
}
/** Выбранный в форме отец участвует в следующем шаге поиска до сохранения. */
export function editorParentHints(
  draft: Person,
  people: Person[],
  accepted: string[],
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
) {
  const base = parentHints(draft, people, links);
  const chosen = base.filter((h) => accepted.includes(`${h.from}:${h.to}`));
  const withParents = (p: Person) => ({
    ...p,
    parents: [
      ...new Set([
        ...p.parents,
        ...chosen.filter((h) => h.to === p.id).map((h) => h.from),
      ]),
    ],
  });
  const next = parentHints(withParents(draft), people.map(withParents), links);
  return [
    ...new Map(
      [...base, ...next].map((h) => [`${h.from}:${h.to}`, h]),
    ).values(),
  ];
}
export function birthSurnameHints(draft: Person, people: Person[]) {
  if (draft.maidenName || resolvedSex(draft) !== "f") return [];
  const values = new Set<string>();
  return draft.parents.flatMap((id) => {
    const parent = people.find((p) => p.id === id);
    if (!parent || resolvedSex(parent) !== "m") return [];
    const surname = surnameForSex(parent.surname, "f");
    if (
      !surname ||
      normalize(surname) === normalize(draft.surname) ||
      values.has(normalize(surname))
    )
      return [];
    values.add(normalize(surname));
    return [{ surname, parent }];
  });
}

/** Общие дети дают повод уточнить брак, но не доказывают его. */
export function marriageHints(person: Person, people: Person[]) {
  const map = new Map(people.map((p) => [p.id, p]));
  const shared = new Map<string, Person[]>();
  for (const child of people) {
    if (!child.parents.includes(person.id)) continue;
    for (const id of child.parents) {
      const other = map.get(id);
      if (
        !other ||
        id === person.id ||
        person.spouses.includes(id) ||
        other.spouses.includes(person.id) ||
        person.parents.includes(id) ||
        other.parents.includes(person.id)
      )
        continue;
      const children = shared.get(id) || [];
      children.push(child);
      shared.set(id, children);
    }
  }
  return [...shared].map(([id, children]) => ({
    person: map.get(id)!,
    children,
  }));
}
