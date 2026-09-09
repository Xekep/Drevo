import {
  SIBLING_LINK_TYPES,
  type SiblingLinkType,
  type Person,
  type FamilyLink,
  type KinshipRole,
} from "./types.ts";

export const SIBLING_NAMES: Record<SiblingLinkType, string> = {
  sibling: "Брат / сестра · кровные, без уточнения",
  full_sibling: "Родные · общие отец и мать",
  paternal_sibling: "Единокровные · общий отец",
  maternal_sibling: "Единоутробные · общая мать",
  step_sibling: "Сводные · без общих кровных родителей",
};
export const isSiblingLink = (type: string): type is SiblingLinkType =>
  (SIBLING_LINK_TYPES as readonly string[]).includes(type);
export const isSymmetricLink = (type: string) =>
  type === "spouse" || type === "sworn_sibling" || isSiblingLink(type);
export const completeParents = (p: Person) =>
  p.parentageComplete === true ||
  (p.parentageComplete !== false && p.parents.length >= 2);

export function siblingRole(
  type: SiblingLinkType,
  person: Pick<Person, "sex">,
): KinshipRole {
  const adjectives = {
    sibling: ["", ""],
    full_sibling: ["родной ", "родная "],
    paternal_sibling: ["единокровный ", "единокровная "],
    maternal_sibling: ["единоутробный ", "единоутробная "],
    step_sibling: ["сводный ", "сводная "],
  };
  const [male, female] = adjectives[type];
  return {
    term:
      person.sex === "u"
        ? `${male}брат / ${female}сестра`
        : person.sex === "f"
          ? `${female}сестра`
          : `${male}брат`,
    description:
      type === "sibling"
        ? "Кровное родство указано напрямую; полнородность и общие родители не уточнены."
        : type === "full_sibling"
          ? "Прямо указаны общие отец и мать; их карточки могут быть неизвестны."
          : type === "paternal_sibling"
            ? "Прямо указаны общий отец и разные матери."
            : type === "maternal_sibling"
              ? "Прямо указаны общая мать и разные отцы."
              : "Прямо указано сводное родство: родители связаны браком, общих кровных родителей нет.",
  };
}

/** Проверяем только противоречия известным фактам, не дополняя родителей. */
export function validateSibling(link: FamilyLink, map: Map<string, Person>) {
  if (!isSiblingLink(link.type)) return;
  const a = map.get(link.from)!,
    b = map.get(link.to)!;
  const ancestorOf = (ancestor: string, child: Person) => {
    const seen = new Set<string>(),
      queue = [...child.parents];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === ancestor) return true;
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(...(map.get(id)?.parents || []));
      }
    }
    return false;
  };
  if (ancestorOf(a.id, b) || ancestorOf(b.id, a))
    throw new Error(
      "Связь брата или сестры противоречит прямой линии предок — потомок.",
    );
  const shared = a.parents.filter((id) => b.parents.includes(id));
  const bothComplete = completeParents(a) && completeParents(b);
  let conflict =
    link.type === "step_sibling"
      ? shared.length > 0
      : bothComplete && shared.length === 0;
  if (link.type === "full_sibling") {
    conflict ||=
      (completeParents(a) && b.parents.some((id) => !a.parents.includes(id))) ||
      (completeParents(b) && a.parents.some((id) => !b.parents.includes(id)));
    for (const sex of ["m", "f"]) {
      const pa = a.parents.find((id) => map.get(id)?.sex === sex);
      const pb = b.parents.find((id) => map.get(id)?.sex === sex);
      conflict ||= !!pa && !!pb && pa !== pb;
    }
  }
  if (link.type === "paternal_sibling" || link.type === "maternal_sibling") {
    const commonSex = link.type === "paternal_sibling" ? "m" : "f";
    const pa = a.parents.find((id) => map.get(id)?.sex === commonSex);
    const pb = b.parents.find((id) => map.get(id)?.sex === commonSex);
    conflict ||=
      (!!pa && !!pb && pa !== pb) ||
      shared.length >= 2 ||
      shared.some((id) => {
        const sex = map.get(id)?.sex;
        return sex !== "u" && sex !== commonSex;
      });
  }
  if (conflict)
    throw new Error(
      "Тип связи брата или сестры противоречит указанным родителям. Уточните родителей или тип родства.",
    );
}
