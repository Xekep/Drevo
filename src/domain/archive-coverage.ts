import { fullName } from "./dates.ts";
import { CLAIM_CONFIDENCE_LABELS } from "./claim-confidence.ts";
import type { Family, PersonValueClaim } from "./types.ts";
import type { ArchiveWarning } from "./archive-quality.ts";

export type QualityCategory =
  | "error"
  | "possible-error"
  | "contradiction"
  | "duplicate"
  | "unverified"
  | "gap";

const contradictoryCodes = new Set([
  "death-before-birth",
  "event-end-before-start",
  "marriage-before-birth",
  "parent-and-spouse",
  "blood-and-step-parent",
  "conflicting-life-facts",
  "competing-life-evidence",
]);

export function qualityCategory(warning: ArchiveWarning): QualityCategory {
  if (warning.code === "possible-duplicate") return "duplicate";
  if (warning.code === "unsourced-event") return "unverified";
  if (warning.code === "unconfirmed-life-facts") return "unverified";
  if (warning.code === "unsourced-card") return "gap";
  if (contradictoryCodes.has(warning.code)) return "contradiction";
  return warning.level === "error" ? "error" : "possible-error";
}

type LifeFact = { label: string; value: string; claim?: PersonValueClaim };
const hasExactSources = (fact: LifeFact) =>
  fact.claim?.value === fact.value && !!fact.claim.sources.length;
const factDetails = (facts: LifeFact[]) => facts.map((fact) =>
  `${fact.label} ${fact.value}`).join(", ");
const factSourceTitles = (facts: LifeFact[]) => [...new Set(facts.flatMap((fact) =>
  fact.claim?.sources.map((source) => source.title.trim()).filter(Boolean) || []))];

/** Missing links and manual assessments are research prompts, not verdicts about truth. */
export function analyzeArchiveCoverage(family: Family): ArchiveWarning[] {
  const warnings: ArchiveWarning[] = [];
  for (const person of family.people) {
    const facts: LifeFact[] = [
      { label: "дата рождения", value: person.birth, claim: person.birthDateClaim },
      { label: "место рождения", value: person.birthPlace, claim: person.birthPlaceClaim },
      { label: "дата смерти", value: person.death || "", claim: person.deathDateClaim },
      { label: "место смерти", value: person.deathPlace || "", claim: person.deathPlaceClaim },
    ].filter((fact) => fact.value.trim());
    const missing = facts.filter((fact) => !hasExactSources(fact));
    const cited = facts.filter(hasExactSources);
    const unconfirmed = cited.filter((fact) =>
      fact.claim?.confidence !== "confirmed" && fact.claim?.confidence !== "conflicting");
    const conflicting = cited.filter((fact) => fact.claim?.confidence === "conflicting");
    if (missing.length)
      warnings.push({
        code: "unsourced-card",
        title: "Нет точных источников для жизненных данных",
        detail: `${fullName(person)}: ${factDetails(missing)}.`,
        rule: "К указанным датам и местам в Drevo не привязаны отдельные источники. Общий источник карточки или события не подтверждает автоматически каждый факт; отсутствие ссылки не означает, что документа не существует.",
        level: "check",
        personIds: [person.id],
      });
    if (unconfirmed.length)
      warnings.push({
        code: "unconfirmed-life-facts",
        title: "Цитируемые факты ещё не подтверждены оценкой исследователя",
        detail: `${fullName(person)}: ${unconfirmed.map((fact) =>
          `${fact.label} ${fact.value} — ${fact.claim?.confidence
            ? CLAIM_CONFIDENCE_LABELS[fact.claim.confidence] : "оценка не задана"}`).join("; ")}.`,
        rule: "К этим значениям прикреплены источники, но оценка исследователя пока не подтверждает их. Наличие источника само по себе не повышает достоверность.",
        level: "check",
        personIds: [person.id],
        sourceTitles: factSourceTitles(unconfirmed),
      });
    if (conflicting.length)
      warnings.push({
        code: "conflicting-life-facts",
        title: "Факты с ручной оценкой «Противоречиво»",
        detail: `${fullName(person)}: ${factDetails(conflicting)}.`,
        rule: "Исследователь отметил противоречие для текущего значения. Сравните источники и при необходимости добавьте альтернативную запись; Drevo не выбирает правильный факт автоматически.",
        level: "check",
        personIds: [person.id],
        sourceTitles: factSourceTitles(conflicting),
      });
    const competing = ([
      ["birth", "дата рождения", person.birth, person.birthDateClaim],
      ["death", "дата смерти", person.death || "", person.deathDateClaim],
      ["birthPlace", "место рождения", person.birthPlace, person.birthPlaceClaim],
      ["deathPlace", "место смерти", person.deathPlace || "", person.deathPlaceClaim],
    ] as const).flatMap(([field, label, value, claim]) => {
      const cited = (person.factAlternatives || []).filter((item) => item.field === field)
        .map((item) => ({ value: item.value, sources: item.sources }));
      if (hasExactSources({ label, value, claim }))
        cited.unshift({ value, sources: claim!.sources });
      return cited.length > 1 ? [{ label, cited }] : [];
    });
    if (competing.length)
      warnings.push({
        code: "competing-life-evidence",
        title: "Источники указывают разные жизненные данные",
        detail: `${fullName(person)}: ${competing.map(({ label, cited }) =>
          `${label} — ${cited.map((item) => item.value).join(" и ")}`).join("; ")}.`,
        rule: "Для разных значений сохранены отдельные источники. Drevo не выбирает правильный вариант автоматически; проверьте документы и явно оцените свидетельства.",
        level: "check",
        personIds: [person.id],
        sourceTitles: [...new Set(competing.flatMap(({ cited }) => cited.flatMap((item) =>
          item.sources)).map((source) => source.title.trim()).filter(Boolean))],
      });

    for (const event of person.events || [])
      if (!event.sources?.length)
        warnings.push({
          code: "unsourced-event",
          title: "Событие без прикреплённого источника",
          detail: `${fullName(person)}: ${event.title?.trim() || "событие"}${event.date || event.dateText ? `, ${event.date || event.dateText}` : ""}.`,
          rule: "К этому событию в Drevo не прикреплён источник. Это повод проверить запись, а не доказательство, что событие не происходило.",
          level: "check",
          personIds: [person.id],
          eventId: event.id,
        });
  }
  return warnings;
}
