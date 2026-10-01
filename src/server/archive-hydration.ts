import type {
  ArchivePhoto,
  Family,
  FamilyLink,
  FamilyUnion,
  Person,
  PhotoTag,
} from "../domain/index.ts";

type StoredRelation = Record<string, unknown>;
type StoredTag = Record<string, unknown>;

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function hydrateRelations(
  rows: StoredRelation[],
  people: Person[],
): FamilyLink[] {
  const map = new Map(people.map((person) => [person.id, person]));
  const links: FamilyLink[] = [];
  for (const row of rows) {
    const from = String(row.source);
    const to = String(row.target);
    const type = String(row.type);
    if (type === "parent") map.get(to)!.parents.push(from);
    else if (type === "spouse") {
      map.get(from)!.spouses.push(to);
      map.get(to)!.spouses.push(from);
    } else
      links.push({
        id: String(row.id),
        ...(row.created_by ? { createdBy: String(row.created_by) } : {}),
        from,
        to,
        type: type as FamilyLink["type"],
        ...(row.note ? { note: String(row.note) } : {}),
        ...(type === "twin" ? { twinKind: (row.twin_kind || "unknown") as FamilyLink["twinKind"] } : {}),
      });
  }
  return links;
}

export function hydrateArchive(
  meta: Record<string, unknown>,
  personRows: Array<Record<string, unknown>>,
  relationRows: StoredRelation[],
  photoRows: Array<Record<string, unknown>>,
  tagRows: StoredTag[],
  unionRows: Array<Record<string, unknown>> = [],
): { family: Family; revision: number } {
  const people = personRows.map((row) => ({
    ...jsonValue<Person>(row.data),
    parents: [],
    spouses: [],
  }));
  const links = hydrateRelations(relationRows, people);
  const photos: ArchivePhoto[] = photoRows.map((row) => ({
    ...jsonValue<ArchivePhoto>(row.data),
    tags: [],
  }));
  const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
  for (const row of tagRows)
    photoMap
      .get(String(row.photo_id))!
      .tags.push(jsonValue<PhotoTag>(row.data));
  return {
    family: {
      title: String(meta.title),
      description: String(meta.description),
      demo: Boolean(meta.demo),
      people,
      ...(unionRows.length ? { unions: unionRows.map((row) => jsonValue<FamilyUnion>(row.data)) } : {}),
      links,
      photos,
    },
    revision: Number(meta.revision),
  };
}
