import type { Person, PlaceLocation } from "./types.ts";

export const placeKey = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/^(?:г\.?|город)\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();
export function placeSearch(text: string) {
  return text.trim();
}
export type PlaceEvent = {
  person: Person;
  kind: "birth" | "death";
  date: string;
  name: string;
};
export type FamilyPlace = {
  key: string;
  name: string;
  events: PlaceEvent[];
  location?: PlaceLocation;
};
export function familyPlaces(people: Person[]): FamilyPlace[] {
  const places = new Map<string, FamilyPlace>();
  for (const person of people)
    for (const kind of ["birth", "death"] as const) {
      const name = (person[`${kind}Place`] || "").trim();
      if (!name) continue;
      const key = placeKey(name),
        group = places.get(key) || { key, name, events: [] };
      const location = person[`${kind}Location`];
      if (location && placeKey(location.place) === key)
        group.location ||= location;
      group.events.push({ person, kind, date: person[kind] || "", name });
      places.set(key, group);
    }
  return [...places.values()].sort(
    (a, b) =>
      b.events.length - a.events.length || a.name.localeCompare(b.name, "ru"),
  );
}
export type PlaceCandidate = {
  lat: number;
  lon: number;
  label: string;
  name: string;
  source?: string;
};
export type PlaceResult = {
  query: string;
  candidates: PlaceCandidate[];
  automatic?: PlaceCandidate;
};
export function photonResult(query: string, value: unknown): PlaceResult {
  const features = (value as { features?: unknown[] })?.features;
  if (!Array.isArray(features))
    throw new Error("Сервис вернул некорректный ответ");
  const candidates: PlaceCandidate[] = [];
  for (const item of features.slice(0, 10)) {
    const f = item as {
        geometry?: { coordinates?: unknown[] };
        properties?: Record<string, unknown>;
      },
      c = f?.geometry?.coordinates,
      p = f?.properties;
    if (
      !c ||
      !p ||
      typeof c[0] !== "number" ||
      typeof c[1] !== "number" ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1]) ||
      Math.abs(c[0]) > 180 ||
      Math.abs(c[1]) > 90 ||
      typeof p.name !== "string"
    )
      continue;
    if (p.osm_key !== "place") continue;
    const label = [
      ...new Set(
        [p.name, p.city, p.district, p.state, p.country].filter(
          (v): v is string => typeof v === "string" && !!v,
        ),
      ),
    ].join(", ");
    if (!candidates.some((v) => v.lat === c[1] && v.lon === c[0]))
      candidates.push({ lat: c[1], lon: c[0], label, name: p.name });
  }
  const needle = placeKey(query),
    exact = candidates.filter((c) => {
      const tokens = needle
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      return tokens.every((token, i) =>
        i === 0
          ? placeKey(c.name) === token
          : placeKey(c.label).includes(token),
      );
    });
  return {
    query,
    candidates,
    ...(exact.length === 1 ? { automatic: exact[0] } : {}),
  };
}
export type WikiMatch = {
  id: string;
  label: string;
  description?: string;
  match?: { text?: string };
  aliases?: string[];
};
export function historicalMatches(query: string, value: unknown): WikiMatch[] {
  const search = (value as { search?: WikiMatch[] })?.search;
  if (!Array.isArray(search)) throw new Error("Справочник названий недоступен");
  return search
    .slice(0, 8)
    .filter(
      (p) =>
        typeof p?.id === "string" &&
        /^Q\d+$/.test(p.id) &&
        typeof p.label === "string" &&
        [
          p.label,
          p.match?.text,
          ...(Array.isArray(p.aliases) ? p.aliases : []),
        ].some((v) => typeof v === "string" && placeKey(v) === placeKey(query)),
    );
}
export function historicalCandidates(
  matches: WikiMatch[],
  value: unknown,
): PlaceCandidate[] {
  type Claim = {
    rank?: string;
    mainsnak?: {
      datavalue?: {
        value?: {
          latitude?: number;
          longitude?: number;
          globe?: string;
          id?: string;
        };
      };
    };
  };
  const entities = (
    value as { entities?: Record<string, { claims?: Record<string, Claim[]> }> }
  )?.entities;
  if (!entities) throw new Error("Справочник координат недоступен");
  return matches.flatMap((p) => {
    const claims = entities[p.id]?.claims;
    if (
      !claims ||
      claims.P31?.some((c) => c.mainsnak?.datavalue?.value?.id === "Q5") ||
      (!claims.P131?.length && !claims.P17?.length)
    )
      return [];
    const coords = (claims.P625 || []).filter((c) => c.rank !== "deprecated");
    const preferred = coords.filter((c) => c.rank === "preferred");
    const values = (preferred.length ? preferred : coords)
      .map((c) => c.mainsnak?.datavalue?.value)
      .filter(
        (c) =>
          c &&
          /^https?:\/\/www.wikidata.org\/entity\/Q2$/.test(c.globe || "") &&
          typeof c.latitude === "number" &&
          typeof c.longitude === "number" &&
          Number.isFinite(c.latitude) &&
          Number.isFinite(c.longitude) &&
          Math.abs(c.latitude) <= 90 &&
          Math.abs(c.longitude) <= 180,
      );
    if (values.length !== 1) return [];
    return [
      {
        lat: values[0]!.latitude!,
        lon: values[0]!.longitude!,
        name: p.label,
        label: [p.label, p.description].filter(Boolean).join(" — "),
        source: `https://www.wikidata.org/wiki/${p.id}`,
      },
    ];
  });
}
