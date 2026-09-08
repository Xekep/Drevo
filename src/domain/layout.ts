import type { Person } from "./types.ts";
import { dateYear } from "./dates.ts";
export const START_YEAR = 1830;
export const END_YEAR = 2035;
export const YEAR_HEIGHT = 8;
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 110;
export const RAIL_WIDTH = 92;
export function centuryLabel(value: number) {
  const values = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const;
  let result = "";
  for (const [number, letter] of values)
    while (value >= number) {
      result += letter;
      value -= number;
    }
  return result;
}
export const yearY = (year: number, start = START_YEAR) =>
  60 + (year - start) * YEAR_HEIGHT;
export const position = (p: Person, start = START_YEAR) => ({
  x: 68 + p.column * 246,
  y: yearY(dateYear(p.birth), start),
});
export const ERAS = [
  {
    name: "Ранние эпохи",
    short: "Ранние эпохи",
    start: 1,
    end: 1547,
    color: "#b8b49a",
    className: "empire",
  },
  {
    name: "Русское царство",
    short: "Русское царство",
    start: 1547,
    end: 1721,
    color: "#b8b49a",
    className: "empire",
  },
  {
    name: "Российская империя",
    short: "Империя",
    start: 1721,
    end: 1917,
    color: "#b6b79b",
    className: "empire",
  },
  {
    name: "Революция и РСФСР",
    short: "1917–1922",
    start: 1917,
    end: 1922,
    color: "#b8a495",
    className: "transition",
  },
  {
    name: "Советский Союз",
    short: "СССР",
    start: 1922,
    end: 1991,
    color: "#b5a18e",
    className: "soviet",
  },
  {
    name: "Россия",
    short: "Россия",
    start: 1991,
    end: 2100,
    color: "#89a293",
    className: "russia",
  },
];
