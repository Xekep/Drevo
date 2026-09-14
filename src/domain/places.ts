import type { Person, PlaceLocation, ArchivePhoto } from "./types.ts";
import { EVENT_NAMES } from "./person-events.ts";

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
export function historicalSearchTerm(text: string) {
  return placeSearch(text).split(",")[0]?.trim() || placeSearch(text);
}

const placeWords = (text: string) =>
  placeKey(text).match(/[\p{L}\p{N}]+/gu) || [];

function samePlaceWord(left: string, right: string) {
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  if (shorter >= 3 && (left.startsWith(right) || right.startsWith(left)))
    return true;
  if (shorter < 5) return false;
  let common = 0;
  while (common < shorter && left[common] === right[common]) common++;
  return common >= Math.min(7, shorter - 1);
}

function placeTextContains(text: string, qualifier: string) {
  const words = placeWords(text);
  return placeWords(qualifier).every((expected) =>
    words.some((actual) => samePlaceWord(expected, actual)),
  );
}
type PlaceEvent = {
  person: Person;
  kind: "birth" | "death" | "event";
  eventId?: string;
  label?: string;
  date: string;
  name: string;
};
export type FamilyPlace = {
  key: string;
  name: string;
  events: PlaceEvent[];
  photos: ArchivePhoto[];
  location?: PlaceLocation;
};
export function familyPlaces(
  people: Person[],
  photos: ArchivePhoto[] = [],
): FamilyPlace[] {
  const places = new Map<string, FamilyPlace>();
  for (const person of people)
    for (const kind of ["birth", "death"] as const) {
      const name = (person[`${kind}Place`] || "").trim();
      if (!name) continue;
      const key = placeKey(name),
        group = places.get(key) || { key, name, events: [], photos: [] };
      const location = person[`${kind}Location`];
      if (location && placeKey(location.place) === key)
        group.location ||= location;
      group.events.push({ person, kind, date: person[kind] || "", name });
      places.set(key, group);
    }
  for (const person of people)
    for (const event of person.events || []) {
      const name = event.place?.trim();
      if (!name) continue;
      const key = placeKey(name),
        group = places.get(key) || { key, name, events: [], photos: [] };
      if (event.location && placeKey(event.location.place) === key)
        group.location ||= event.location;
      group.events.push({
        person,
        kind: "event",
        eventId: event.id,
        label: event.title || EVENT_NAMES[event.type],
        date: event.date || event.dateText || "",
        name,
      });
      places.set(key, group);
    }
  for (const photo of photos) {
    const name = photo.place?.trim();
    if (!name) continue;
    const key = placeKey(name),
      group = places.get(key) || { key, name, events: [], photos: [] };
    group.photos.push(photo);
    places.set(key, group);
  }
  return [...places.values()].sort(
    (a, b) =>
      b.events.length + b.photos.length - a.events.length - a.photos.length ||
      a.name.localeCompare(b.name, "ru"),
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
  notice?: string;
};
export function placeCandidateMatchesQuery(
  query: string,
  candidate: PlaceCandidate,
) {
  const [name, ...qualifiers] = placeKey(query)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    placeKey(candidate.name) === name &&
    qualifiers.every((qualifier) =>
      placeTextContains(candidate.label, qualifier),
    )
  );
}

export function mergeNearbyPlaceCandidates(
  preferred: PlaceCandidate[],
  supplemental: PlaceCandidate[],
) {
  const merged = [...preferred];
  for (const candidate of supplemental) {
    const duplicate = merged.some((existing) => {
      if (placeKey(existing.name) !== placeKey(candidate.name)) return false;
      const latitudeKm = (existing.lat - candidate.lat) * 111.32,
        meanLatitude = ((existing.lat + candidate.lat) / 2) * (Math.PI / 180),
        longitudeKm =
          (existing.lon - candidate.lon) * 111.32 * Math.cos(meanLatitude);
      return Math.hypot(latitudeKm, longitudeKm) <= 1;
    });
    if (!duplicate) merged.push(candidate);
  }
  return merged;
}

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
        [p.name, p.city, p.district, p.county, p.state, p.country].filter(
          (v): v is string => typeof v === "string" && !!v,
        ),
      ),
    ].join(", ");
    if (!candidates.some((v) => v.lat === c[1] && v.lon === c[0]))
      candidates.push({ lat: c[1], lon: c[0], label, name: p.name });
  }
  const labelCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = placeKey(candidate.label);
    labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
  }
  const distinguished = candidates.map((candidate) =>
      (labelCounts.get(placeKey(candidate.label)) || 0) > 1
        ? {
            ...candidate,
            label: `${candidate.label} · координаты ${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)}`,
          }
        : candidate,
    ),
    exact = distinguished.filter((candidate) =>
      placeCandidateMatchesQuery(query, candidate),
    );
  return {
    query,
    candidates: distinguished,
    ...(exact.length === 1 ? { automatic: exact[0] } : {}),
  };
}
export type WikiMatch = {
  id: string;
  label: string;
  description?: string;
  match?: { text?: string };
  aliases?: string[];
  contextMatched?: boolean;
};
export function historicalMatches(query: string, value: unknown): WikiMatch[] {
  const search = (value as { search?: WikiMatch[] })?.search;
  if (!Array.isArray(search)) throw new Error("Справочник названий недоступен");
  const [name, ...qualifiers] = placeKey(query)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    named = search
      .slice(0, 50)
      .filter(
        (p) =>
          typeof p?.id === "string" &&
          /^Q\d+$/.test(p.id) &&
          typeof p.label === "string" &&
          [
            p.label,
            p.match?.text,
            ...(Array.isArray(p.aliases) ? p.aliases : []),
          ].some((v) => typeof v === "string" && placeKey(v) === name),
      );
  if (!qualifiers.length)
    return named.slice(0, 8).map((match) => ({
      ...match,
      contextMatched: true,
    }));
  const contextual = named.filter((match) =>
    qualifiers.every((qualifier) =>
      placeTextContains(
        [
          match.label,
          match.description,
          match.match?.text,
          ...(match.aliases || []),
        ]
          .filter(Boolean)
          .join(" "),
        qualifier,
      ),
    ),
  );
  return (contextual.length ? contextual : named).slice(0, 8).map((match) => ({
    ...match,
    contextMatched: contextual.length > 0,
  }));
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
