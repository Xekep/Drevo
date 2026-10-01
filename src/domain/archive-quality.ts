import { dateBound, dateYear, fullName, validDate } from "./dates.ts";
import type { ExtraLinkType, Family, Person, Source } from "./types.ts";

export type ArchiveWarning = {
  code: string;
  title: string;
  detail: string;
  rule: string;
  level: "error" | "check";
  personIds: string[];
  sourceTitles?: string[];
  eventId?: string;
};

const normalized = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е");

const linkNames: Record<ExtraLinkType, string> = {
  adoptive_parent: "усыновление",
  foster_parent: "приёмное родительство",
  presumed_parent: "предполагаемое родительство",
  step_parent: "отчим или мачеха",
  godparent: "крёстное родительство",
  nurse: "вскармливание",
  sworn_sibling: "названое братство",
  twin: "близнецы",
  guardian: "опека",
};

function knownInterval(value?: string) {
  return value && validDate(value)
    ? { first: dateBound(value, false), last: dateBound(value, true) }
    : null;
}

function completedYears(earlier: string, later: string) {
  const years = Number(later.slice(0, 4)) - Number(earlier.slice(0, 4));
  return years - Number(later.slice(5) < earlier.slice(5));
}

function sourceTitles(sources?: Source[]) {
  return [
    ...new Set(
      (sources || []).map((source) => source.title.trim()).filter(Boolean),
    ),
  ];
}

/** Read-only diagnostics; incomplete visible projections must not become "missing person" errors. */
export function analyzeArchiveWarnings(family: Family): ArchiveWarning[] {
  const people = family.people;
  const peopleMap = new Map(people.map((person) => [person.id, person]));
  const warnings = new Map<string, ArchiveWarning>();
  const add = (warning: ArchiveWarning) => {
    const key = `${warning.code}:${[...warning.personIds].sort().join(":")}:${warning.eventId || ""}`;
    warnings.set(key, warning);
  };

  for (const person of people) {
    const birth = knownInterval(person.birth);
    const death = knownInterval(person.death);
    if (birth && death && death.last < birth.first)
      add({
        code: "death-before-birth",
        title: "Дата смерти раньше рождения",
        detail: `${fullName(person)}: рождение ${person.birth}, смерть ${person.death}.`,
        rule: "Даже с учётом неполных дат смерть целиком предшествует рождению.",
        level: "error",
        personIds: [person.id],
        sourceTitles: sourceTitles(person.sources),
      });

    for (const event of person.events || []) {
      const start = knownInterval(event.date);
      const end = knownInterval(event.endDate);
      const sources = sourceTitles(event.sources);
      if (start && end && end.last < start.first)
        add({
          code: "event-end-before-start",
          title: "Конец события раньше начала",
          detail: `${fullName(person)}: ${event.title?.trim() || "событие"} — начало ${event.date}, конец ${event.endDate}.`,
          rule: "Возможные интервалы начала и окончания не пересекаются и идут в обратном порядке.",
          level: "error",
          personIds: [person.id],
          eventId: event.id,
          sourceTitles: sources,
        });
      if (
        birth &&
        event.type === "marriage" &&
        start &&
        start.last < birth.first
      )
        add({
          code: "marriage-before-birth",
          title: "Брак раньше рождения",
          detail: `${fullName(person)}: рождение ${person.birth}, брак ${event.date}.`,
          rule: "Даже с учётом неполных дат брак целиком предшествует рождению.",
          level: "error",
          personIds: [person.id],
          eventId: event.id,
          sourceTitles: sources,
        });
    }

    if (person.parents.includes(person.id))
      add({
        code: "self-parent",
        title: "Человек указан собственным родителем",
        detail: fullName(person),
        rule: "Карточка не может быть своим кровным родителем.",
        level: "error",
        personIds: [person.id],
      });
    if (person.spouses.includes(person.id))
      add({
        code: "self-spouse",
        title: "Человек указан собственным супругом",
        detail: fullName(person),
        rule: "Связь супругов должна соединять двух разных людей.",
        level: "error",
        personIds: [person.id],
      });
    for (const [kind, ids] of [
      ["родитель", person.parents],
      ["супруг", person.spouses],
    ] as const) {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id) && peopleMap.has(id))
          add({
            code: kind === "родитель" ? "repeated-parent" : "repeated-spouse",
            title: "Повторяющаяся семейная связь",
            detail: `${fullName(person)}: ${kind} ${fullName(peopleMap.get(id)!)} указан несколько раз.`,
            rule: "Одна и та же связь записывается один раз.",
            level: "error",
            personIds: [person.id, id],
          });
        seen.add(id);
      }
    }
    for (const id of person.parents) {
      if (person.spouses.includes(id) && peopleMap.has(id))
        add({
          code: "parent-and-spouse",
          title: "Несовместимые семейные роли",
          detail: `${fullName(peopleMap.get(id)!)} одновременно указан родителем и супругом ${fullName(person)}.`,
          rule: "Такое сочетание связей требует отдельной проверки записей.",
          level: "check",
          personIds: [person.id, id],
        });
    }
    const knownParentIds = [...new Set(person.parents)].filter((id) =>
      peopleMap.has(id),
    );
    if (knownParentIds.length > 2)
      add({
        code: "many-blood-parents",
        title: "Больше двух кровных родителей",
        detail: `${fullName(person)}: в карточке указано ${knownParentIds.length} кровных родителей.`,
        rule: "Усыновление, опека и другие роли записываются отдельными типами связей.",
        level: "check",
        personIds: [person.id, ...knownParentIds],
      });

    for (const parentId of new Set(person.parents)) {
      const parent = peopleMap.get(parentId);
      const parentBirth = knownInterval(parent?.birth);
      const parentDeath = knownInterval(parent?.death);
      if (!parent || !birth || parentId === person.id) continue;
      if (parentBirth) {
        const youngestPossible = completedYears(parentBirth.last, birth.first);
        const oldestPossible = completedYears(parentBirth.first, birth.last);
        if (oldestPossible < 12)
          add({
            code: "young-parent",
            title: "Очень маленький возраст родителя",
            detail: `${fullName(parent)} (${parent.birth}) и ${fullName(person)} (${person.birth}).`,
            rule: "Даже с учётом точности дат родителю меньше 12 лет при рождении ребёнка.",
            level: "check",
            personIds: [parent.id, person.id],
          });
        else if (youngestPossible > 80)
          add({
            code: "old-parent",
            title: "Необычно большой возраст родителя",
            detail: `${fullName(parent)} (${parent.birth}) и ${fullName(person)} (${person.birth}).`,
            rule: "Даже с учётом точности дат родителю больше 80 лет при рождении ребёнка.",
            level: "check",
            personIds: [parent.id, person.id],
          });
      }
      if (
        parentDeath &&
        Date.parse(birth.first) - Date.parse(parentDeath.last) >
          300 * 24 * 60 * 60 * 1000
      )
        add({
          code: "late-after-parent-death",
          title: "Ребёнок родился заметно позже смерти родителя",
          detail: `${fullName(parent)}: смерть ${parent.death}; ${fullName(person)}: рождение ${person.birth}.`,
          rule: "Даже с учётом неточных дат после смерти родителя прошло больше 300 дней. Проверьте тип родства и даты.",
          level: "check",
          personIds: [parent.id, person.id],
        });
    }
  }

  const extraLinks = new Set<string>();
  for (const link of family.links || []) {
    const from = peopleMap.get(link.from);
    const to = peopleMap.get(link.to);
    if (!from || !to) continue;
    if (link.from === link.to)
      add({
        code: "self-extra-link",
        title: "Связь человека с самим собой",
        detail: `${fullName(from)}: дополнительная связь «${linkNames[link.type]}».`,
        rule: "Дополнительная связь должна соединять двух разных людей.",
        level: "error",
        personIds: [from.id],
      });
    const pair =
      link.type === "sworn_sibling" || link.type === "twin"
        ? [link.from, link.to].sort().join(":")
        : `${link.from}:${link.to}`;
    const key = `${link.type}:${pair}`;
    if (extraLinks.has(key))
      add({
        code: "repeated-extra-link",
        title: "Повторяющаяся дополнительная связь",
        detail: `${fullName(from)} и ${fullName(to)}: связь «${linkNames[link.type]}» записана несколько раз.`,
        rule: "Связь одного типа между этой парой записывается один раз.",
        level: "error",
        personIds: [from.id, to.id],
      });
    extraLinks.add(key);
    if (link.type === "step_parent" && to.parents.includes(from.id))
      add({
        code: "blood-and-step-parent",
        title: "Несовместимые типы родительства",
        detail: `${fullName(from)} указан одновременно кровным родителем и отчимом/мачехой ${fullName(to)}.`,
        rule: "Кровное родительство и роль отчима или мачехи для одной пары требуют проверки.",
        level: "check",
        personIds: [from.id, to.id],
      });
  }

  const graph = new Map<string, string[]>(
    people.map((person) => [
      person.id,
      person.parents.filter((id) => peopleMap.has(id) && id !== person.id),
    ]),
  );
  for (const link of family.links || [])
    if (
      (["adoptive_parent", "foster_parent", "presumed_parent", "step_parent"].includes(link.type)) &&
      graph.has(link.to) &&
      graph.has(link.from) &&
      link.from !== link.to
    )
      graph.get(link.to)!.push(link.from);
  const visited = new Set<string>();
  const active = new Map<string, number>();
  for (const start of graph.keys()) {
    if (visited.has(start)) continue;
    const path: string[] = [];
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    while (stack.length) {
      const top = stack.at(-1)!;
      if (!active.has(top.id)) {
        active.set(top.id, path.length);
        path.push(top.id);
      }
      const parents = graph.get(top.id)!;
      if (top.next >= parents.length) {
        visited.add(top.id);
        active.delete(top.id);
        path.pop();
        stack.pop();
        continue;
      }
      const parentId = parents[top.next++];
      if (active.has(parentId)) {
        const ids = path.slice(active.get(parentId)!);
        add({
          code: "parent-cycle",
          title: "Цикл родительских связей",
          detail: `${[...ids, parentId].map((id) => fullName(peopleMap.get(id)!)).join(" → ")}.`,
          rule: "Путь по кровным и дополнительным родительским связям не должен возвращаться к исходному человеку.",
          level: "error",
          personIds: ids,
        });
      } else if (!visited.has(parentId)) stack.push({ id: parentId, next: 0 });
    }
  }

  const duplicates = new Map<string, Person[]>();
  for (const person of people) {
    const birth =
      person.birth && validDate(person.birth) ? dateYear(person.birth) : null;
    const name = normalized(fullName(person));
    if (!name || birth === null) continue;
    const key = `${name}:${birth}`;
    const group = duplicates.get(key) || [];
    group.push(person);
    duplicates.set(key, group);
  }
  for (const group of duplicates.values())
    if (group.length > 1)
      add({
        code: "possible-duplicate",
        title: "Возможный дубль",
        detail: `${fullName(group[0])}, ${dateYear(group[0].birth)}: ${group.length} записи.`,
        rule: "ФИО и год рождения совпали. Это подсказка для сравнения, а не подтверждение идентичности.",
        level: "check",
        personIds: group.map((person) => person.id),
      });

  return [...warnings.values()];
}
