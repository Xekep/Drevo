import { fullName } from "./dates.ts";
import type { Family } from "./types.ts";
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
]);

export function qualityCategory(warning: ArchiveWarning): QualityCategory {
  if (warning.code === "possible-duplicate") return "duplicate";
  if (warning.code === "unsourced-event") return "unverified";
  if (warning.code === "unsourced-card") return "gap";
  if (contradictoryCodes.has(warning.code)) return "contradiction";
  return warning.level === "error" ? "error" : "possible-error";
}

/** Missing source attachments are research prompts, not a claim that the fact is false. */
export function analyzeArchiveCoverage(family: Family): ArchiveWarning[] {
  const warnings: ArchiveWarning[] = [];
  for (const person of family.people) {
    const fields = [
      person.birth && "дата рождения",
      person.birthPlace && "место рождения",
      person.death && "дата смерти",
      person.deathPlace && "место смерти",
    ].filter(Boolean);
    if (fields.length && !person.sources?.length)
      warnings.push({
        code: "unsourced-card",
        title: "У жизненных данных нет источника в карточке",
        detail: `${fullName(person)}: ${fields.join(", ")}.`,
        rule: "В карточке указаны жизненные данные, но к самой карточке не прикреплён источник. Источник у отдельного события не подтверждает автоматически эти поля.",
        level: "check",
        personIds: [person.id],
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
