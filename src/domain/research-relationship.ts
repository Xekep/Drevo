import { fullName } from "./dates.ts";
import { executeResearchTool } from "./research-tools.ts";
import type { Family } from "./types.ts";

type ChatTurn = {
  role: "user" | "assistant";
  content: string;
  hidden?: boolean;
  references?: unknown[];
};

type PersonSummary = { id: string; name: string };
type RelationshipResult = {
  first: PersonSummary;
  second: PersonSummary;
  relation: {
    kind: string;
    roles?: Array<{ term: string }>;
    distances?: [number, number];
  };
};

type RelationshipAnswer = {
  answer: string;
  references: Array<{ kind: "person"; id: string; label: string }>;
};

/** Answer a requester-relative kinship question from the archive calculation. */
export function requesterRelationshipAnswer(
  family: Family,
  requesterId: string | null | undefined,
  message: string,
  history: ChatTurn[],
  selectedPersonId?: string,
): RelationshipAnswer | null {
  const selfToOther =
    /(?:кем\s+я(?:\s+\S+){0,3}\s+прихожусь|кто\s+я\s+(?:ему|ей|им|для\s+него|для\s+неё))/iu.test(
      message,
    );
  const otherToSelf =
    /(?:кем\s+мне(?:\s+\S+){0,3}\s+приходится|кто\s+(?:он|она)\s+мне)/iu.test(
      message,
    );
  if (!selfToOther && !otherToSelf) return null;

  const requester = family.people.find((person) => person.id === requesterId);
  if (!requester)
    return {
      answer:
        "Чтобы вычислить родство с вами, сначала привяжите аккаунт к своей карточке в древе.",
      references: [],
    };

  const previousQuestion = [...history]
    .reverse()
    .find((turn) => turn.role === "user" && !turn.hidden)?.content;
  const previousAnswer = [...history]
    .reverse()
    .find((turn) => turn.role === "assistant" && !turn.hidden);
  const referencedIds = new Set(
    (previousAnswer?.references || [])
      .filter((item): item is { kind: "person"; id: string } =>
        Boolean(
          item &&
          typeof item === "object" &&
          "kind" in item &&
          item.kind === "person" &&
          "id" in item &&
          typeof item.id === "string",
        ),
      )
      .map((item) => item.id),
  );
  const pronoun = /(?:ему|ей|им|него|неё)/iu.test(message);
  const previousName = previousQuestion?.match(
    /(?:^|\s)(?:у|о|об|про|для|с)\s+([\p{L}-]{3,}\s+[\p{L}-]{3,})/iu,
  )?.[1];
  const query = pronoun ? previousName || previousQuestion : message;
  const matches = query
    ? (
        executeResearchTool(family, "search_people", {
          query,
          limit: 10,
        }) as { people: PersonSummary[] }
      ).people.filter((person) => person.id !== requester.id)
    : [];
  const referencedMatches = matches.filter((person) =>
    referencedIds.has(person.id),
  );
  const target = family.people.find(
    (person) =>
      person.id ===
      ((previousName ? matches[0]?.id : referencedMatches[0]?.id) ||
        (matches.length === 1 ? matches[0].id : "") ||
        (selectedPersonId !== requester.id ? selectedPersonId : "")),
  );
  if (!target)
    return {
      answer:
        "Не могу однозначно определить, о ком речь. Назовите человека или выберите его карточку, и я рассчитаю родство по архиву.",
      references: [],
    };

  const targetLink = `[[person:${target.id}|${fullName(target)}]]`;
  const result = executeResearchTool(family, "get_relationship", {
    firstPersonId: requester.id,
    secondPersonId: target.id,
  }) as RelationshipResult;
  const references: RelationshipAnswer["references"] = [
    { kind: "person", id: target.id, label: fullName(target) },
  ];

  // A generic family path can conceal a precise, documented blood relation
  // to the target's spouse. Prefer that direct evidence to a made-up chain.
  if (result.relation.kind === "family") {
    const relatives = family.people
      .filter(
        (person) =>
          target.spouses.includes(person.id) ||
          person.spouses.includes(target.id),
      )
      .map((spouse) => ({
        spouse,
        result: executeResearchTool(family, "get_relationship", {
          firstPersonId: requester.id,
          secondPersonId: spouse.id,
        }) as RelationshipResult,
      }))
      .filter(({ result }) =>
        ["blood", "direct"].includes(result.relation.kind),
      )
      .sort(
        (left, right) =>
          (left.result.relation.distances?.[0] || 0) +
          (left.result.relation.distances?.[1] || 0) -
          (right.result.relation.distances?.[0] || 0) -
          (right.result.relation.distances?.[1] || 0),
      );
    const closest = relatives[0];
    if (closest?.result.relation.roles?.[1]?.term) {
      const spouse = closest.spouse;
      references.push({
        kind: "person",
        id: spouse.id,
        label: fullName(spouse),
      });
      return {
        answer: `${targetLink} и [[person:${spouse.id}|${fullName(spouse)}]] состоят в браке. ${fullName(spouse)} приходится вам **${closest.result.relation.roles[1].term}**. Прямое кровное родство между вами и ${fullName(target)} в архиве не указано.`,
        references,
      };
    }
  }

  const role = result.relation.roles?.[selfToOther ? 0 : 1]?.term;
  return {
    answer:
      result.relation.kind === "unknown" || !role
        ? `В доступных данных не удалось установить родство между вами и ${targetLink}. Это не доказывает, что его нет.`
        : selfToOther
          ? `Вы — **${role}** по отношению к ${targetLink} (по данным архива).`
          : `${targetLink} — **${role}** по отношению к вам (по данным архива).`,
    references,
  };
}
