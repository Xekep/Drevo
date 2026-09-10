export type TreeDetailLevel = "full" | "compact" | "overview" | "distant";

export const TREE_ZOOM = {
  desktop: {
    min: 0.08,
    max: 1.8,
    full: 0.72,
    compact: 0.42,
    overview: 0.22,
  },
  mobile: {
    min: 0.22,
    max: 2.4,
    full: 0.95,
    compact: 0.62,
    overview: 0.34,
  },
} as const;

export function treeDetailAtZoom(
  zoom: number,
  narrow: boolean,
): TreeDetailLevel {
  const levels = narrow ? TREE_ZOOM.mobile : TREE_ZOOM.desktop;
  if (zoom < levels.overview) return "distant";
  if (zoom < levels.compact) return "overview";
  if (zoom < levels.full) return "compact";
  return "full";
}

export function distantPersonLabel(person: {
  surname: string;
  name: string;
  patronymic: string;
}) {
  const surname = person.surname.trim();
  const name = person.name.trim();
  if (surname) return `${surname}${name ? ` ${name[0]}.` : ""}`;
  return name || person.patronymic.trim() || "Без имени";
}
