import type { Person } from "./types.ts";

const normalize = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");
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

/** Только однозначные распространённые окончания; двойную фамилию не преобразуем. */
export function surnameForSex(
  surname: string,
  sex: Person["sex"],
): string | null {
  if (sex === "u" || /[\s-]/.test(surname.trim())) return null;
  const value = surname.trim();
  if (sex === "f") {
    if (/(ов|ев|ёв|ин|ын)$/i.test(value)) return value + "а";
    if (/ский$/i.test(value)) return value.slice(0, -4) + "ская";
    if (/цкий$/i.test(value)) return value.slice(0, -4) + "цкая";
  } else {
    if (/(ова|ева|ёва|ина|ына)$/i.test(value)) return value.slice(0, -1);
    if (/ская$/i.test(value)) return value.slice(0, -4) + "ский";
    if (/цкая$/i.test(value)) return value.slice(0, -4) + "цкий";
  }
  if (/(енко|ко|ич|ых|их)$/i.test(value)) return value;
  return null;
}
function surnameKey(p: Person) {
  return normalize(surnameForSex(p.surname, "m") || p.surname);
}
export type ParentHint = {
  from: string;
  to: string;
  person: Person;
  role: "father" | "child";
  reason: string;
};
export function parentHints(draft: Person, people: Person[]): ParentHint[] {
  const all = new Map(
    people.filter((p) => p.id !== draft.id).map((p) => [p.id, p]),
  );
  all.set(draft.id, draft);
  const hints: ParentHint[] = [];
  function plausible(father: Person, child: Person) {
    if (
      father.id === child.id ||
      resolvedSex(father) !== "m" ||
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
        return p && resolvedSex(p) === "m";
      })
    )
      return false;
    if (!matchesPatronymic(father.name, child.patronymic)) return false;
    const birth = child.birth ? Number(child.birth.slice(0, 4)) : null;
    const parentBirth = father.birth ? Number(father.birth.slice(0, 4)) : null;
    if (
      birth !== null &&
      parentBirth !== null &&
      (birth - parentBirth < 14 || birth - parentBirth > 75)
    )
      return false;
    if (
      birth !== null &&
      father.death &&
      Number(father.death.slice(0, 4)) < birth - 1
    )
      return false;
    const visited = new Set<string>(),
      queue = [...father.parents];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === child.id) return false;
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(...(all.get(id)?.parents || []));
    }
    return true;
  }
  for (const p of people) {
    for (const [father, child, role] of [
      [p, draft, "father"],
      [draft, p, "child"],
    ] as const) {
      if (!plausible(father, child)) continue;
      hints.push({
        from: father.id,
        to: child.id,
        person: p,
        role,
        reason: `Имя ${father.name} соответствует отчеству ${child.patronymic}${surnameKey(father) === surnameKey(child) ? "; совпадает фамилия" : ""}.`,
      });
    }
  }
  return hints.sort(
    (a, b) =>
      Number(surnameKey(b.person) === surnameKey(draft)) -
        Number(surnameKey(a.person) === surnameKey(draft)) ||
      a.person.surname.localeCompare(b.person.surname, "ru"),
  );
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
