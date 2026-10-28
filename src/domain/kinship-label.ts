import type { Relation } from "./types.ts";

/** The same short, capitalized relationship term in tree cards and projections. */
export function kinshipRelationLabel(relation: Relation) {
  const label = relation.roles?.[0]?.term ||
    (relation.kind === "unknown" ? "Родство не установлено" : "Семейная связь");
  return label[0].toLocaleUpperCase("ru") + label.slice(1);
}
