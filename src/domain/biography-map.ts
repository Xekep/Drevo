import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

export type BiographyMap = FeatureCollection<
  Geometry | null,
  Record<string, unknown>
> & { name?: string };
export const BIOGRAPHY_MAP_LIMIT = 100_000;
export const BIOGRAPHY_MAP_POINTS = 2000;

/** Only embedded geographic data is accepted. Files, URLs and plugin commands
 * are never evaluated while displaying a person's biography. */
export function parseBiographyMap(source: string): BiographyMap {
  if (source.length > BIOGRAPHY_MAP_LIMIT)
    throw new Error("Карта слишком большая: максимум 100000 символов.");
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("Не удалось прочитать GeoJSON. Проверьте формат карты.");
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  let count = 0;
  const coordinate = (value: unknown): Position => {
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      value.length > 3 ||
      !value.every((v) => typeof v === "number" && Number.isFinite(v)) ||
      Math.abs(value[0]) > 180 ||
      Math.abs(value[1]) > 90
    )
      throw new Error(
        "Координаты GeoJSON: долгота от −180 до 180, затем широта от −90 до 90.",
      );
    if (++count > BIOGRAPHY_MAP_POINTS)
      throw new Error("В карте допускается до 2000 координат.");
    return [...value];
  };
  const positions = (value: unknown, minimum: number) => {
    if (!Array.isArray(value) || value.length < minimum)
      throw new Error("Недостаточно координат в геометрии карты.");
    return value.map(coordinate);
  };
  const ring = (value: unknown) => {
    const result = positions(value, 4),
      first = result[0],
      last = result.at(-1)!;
    if (first.length !== last.length || first.some((n, i) => n !== last[i]))
      throw new Error("Контур GeoJSON должен быть замкнут.");
    return result;
  };
  const array = <T>(value: unknown, read: (item: unknown) => T): T[] => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > BIOGRAPHY_MAP_POINTS
    )
      throw new Error("Неверный список геометрий карты.");
    return value.map(read);
  };
  function geometry(value: unknown, depth = 0): Geometry {
    if (!object(value) || depth > 8)
      throw new Error("Неверная геометрия карты.");
    switch (value.type) {
      case "Point":
        return { type: value.type, coordinates: coordinate(value.coordinates) };
      case "MultiPoint":
        return {
          type: value.type,
          coordinates: positions(value.coordinates, 1),
        };
      case "LineString":
        return {
          type: value.type,
          coordinates: positions(value.coordinates, 2),
        };
      case "MultiLineString":
        return {
          type: value.type,
          coordinates: array(value.coordinates, (v) => positions(v, 2)),
        };
      case "Polygon":
        return {
          type: value.type,
          coordinates: array(value.coordinates, ring),
        };
      case "MultiPolygon":
        return {
          type: value.type,
          coordinates: array(value.coordinates, (v) => array(v, ring)),
        };
      case "GeometryCollection":
        return {
          type: value.type,
          geometries: array(value.geometries, (v) => geometry(v, depth + 1)),
        };
      default:
        throw new Error("Неизвестный тип геометрии GeoJSON.");
    }
  }
  function feature(
    value: unknown,
  ): Feature<Geometry | null, Record<string, unknown>> {
    if (!object(value) || value.type !== "Feature")
      throw new Error("Неверный объект GeoJSON.");
    const properties = object(value.properties) ? { ...value.properties } : {};
    const bounded = (item: unknown, depth = 0): void => {
      if (depth > 16)
        throw new Error("Слишком сложные свойства объектов GeoJSON.");
      if (item && typeof item === "object")
        for (const child of Object.values(item)) bounded(child, depth + 1);
    };
    bounded(properties);
    return {
      type: "Feature",
      // RFC 7946 permits unlocated features. Preserve them as records rather
      // than inventing coordinates or rejecting the entire collection.
      geometry: value.geometry === null ? null : geometry(value.geometry),
      properties,
      ...(typeof value.id === "string" || typeof value.id === "number"
        ? { id: value.id }
        : {}),
    };
  }
  if (!object(raw)) throw new Error("Карта должна содержать объект GeoJSON.");
  const features =
    raw.type === "FeatureCollection"
      ? raw.features
      : [raw.type === "Feature" ? raw : { type: "Feature", geometry: raw }];
  if (!Array.isArray(features) || features.length > 500)
    throw new Error("В карте допускается до 500 объектов.");
  return {
    type: "FeatureCollection",
    ...(typeof raw.name === "string" ? { name: raw.name.slice(0, 200) } : {}),
    features: features.map(feature),
  };
}

export function biographyMapRoute(
  map: BiographyMap,
  connect: boolean,
): BiographyMap {
  const features = map.features.filter(
    (f) => f.properties?.drevoRoute !== true,
  );
  const coordinates = features.flatMap((f) =>
    f.geometry?.type === "Point" ? [f.geometry.coordinates] : [],
  );
  if (connect && coordinates.length > 1)
    features.push({
      type: "Feature",
      properties: { drevoRoute: true, name: "Маршрут" },
      geometry: { type: "LineString", coordinates },
    });
  return { ...map, features };
}

export function biographyMapBlock(map: BiographyMap) {
  return "```geojson\n" + JSON.stringify(map, null, 2) + "\n```";
}
