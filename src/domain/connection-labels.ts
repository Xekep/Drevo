import type { Person } from "./types.ts";
import { CONNECTION_NAMES, type ConnectionType } from "./mutations.ts";
import { resolvedSex } from "./name-hints.ts";

type NamedPerson = Pick<Person, "sex" | "name" | "patronymic">;

/** Подпись роли не угадывает пол, если он неизвестен и не следует из имени. */
export function connectionRoleName(
  type: ConnectionType,
  person?: NamedPerson,
  side: "from" | "to" = "from",
): string {
  const sex = person ? resolvedSex(person) : "u";
  switch (type) {
    case "parent":
      return side === "to"
        ? sex === "m" ? "сын" : sex === "f" ? "дочь" : "ребёнок"
        : sex === "m" ? "отец" : sex === "f" ? "мать" : "родитель";
    case "adoptive_parent":
      return side === "to"
        ? sex === "m" ? "усыновлённый сын" : sex === "f" ? "удочерённая дочь" : "усыновлённый ребёнок"
        : sex === "m" ? "усыновитель" : sex === "f" ? "усыновительница" : "усыновитель";
    case "foster_parent":
      return side === "to"
        ? sex === "m" ? "приёмный сын" : sex === "f" ? "приёмная дочь" : "приёмный ребёнок"
        : sex === "m" ? "приёмный отец" : sex === "f" ? "приёмная мать" : "приёмный родитель";
    case "presumed_parent":
      return side === "to"
        ? sex === "m" ? "предполагаемый сын" : sex === "f" ? "предполагаемая дочь" : "предполагаемый ребёнок"
        : sex === "m" ? "предполагаемый отец" : sex === "f" ? "предполагаемая мать" : "предполагаемый родитель";
    case "step_parent":
      return side === "to"
        ? sex === "m" ? "пасынок" : sex === "f" ? "падчерица" : "пасынок или падчерица"
        : sex === "m" ? "отчим" : sex === "f" ? "мачеха" : "супруг родителя";
    case "godparent":
      return side === "to"
        ? sex === "m" ? "крестник" : sex === "f" ? "крестница" : "крёстный ребёнок"
        : sex === "m" ? "крёстный отец" : sex === "f" ? "крёстная мать" : "крёстный родитель";
    case "nurse":
      return side === "to"
        ? sex === "m" ? "вскормленный мальчик" : sex === "f" ? "вскормленная девочка" : "вскормленный ребёнок"
        : "кормилица";
    case "guardian":
      return side === "to"
        ? sex === "m" ? "подопечный" : sex === "f" ? "подопечная" : "подопечный человек"
        : sex === "f" ? "опекунша" : "опекун";
    case "sworn_sibling":
      return sex === "m" ? "названый брат" : sex === "f" ? "названая сестра" : "названый родственник";
    case "twin":
      return sex === "m" ? "брат-близнец" : sex === "f" ? "сестра-близнец" : "близнец";
    default:
      return CONNECTION_NAMES[type];
  }
}

export function connectionPairName(
  type: ConnectionType,
  from?: NamedPerson,
  to?: NamedPerson,
  reversed = false,
): string {
  if (type === "parent" || type === "spouse") return CONNECTION_NAMES[type];
  const left = connectionRoleName(type, from);
  const right = connectionRoleName(type, to, "to");
  const first = reversed ? right : left;
  const last = reversed ? left : right;
  const arrow = type === "sworn_sibling" || type === "twin" ? "↔" : reversed ? "←" : "→";
  return `${first[0].toLocaleUpperCase("ru")}${first.slice(1)} ${arrow} ${last}`;
}
