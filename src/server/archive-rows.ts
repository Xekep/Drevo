import type { Family } from "../domain/index.ts";

export type JsonRow = { id: string; data: string };
export type RelationRow = {
  id: string;
  source: string;
  target: string;
  type: string;
  note: string;
  twinKind: string | null;
  createdBy: string | null;
};
export type TagRow = {
  id: string;
  photoId: string;
  personId: string;
  data: string;
};
export type UnionRow = { id: string; participantA: string; participantB: string; data: string };

export type ArchiveRows = {
  people: JsonRow[];
  unions: UnionRow[];
  relations: RelationRow[];
  photos: JsonRow[];
  tags: TagRow[];
};

/** Stable serialization shared by the SQLite store and PostgreSQL parity work. */
export function archiveRows(family: Family): ArchiveRows {
  const people = family.people.map((person) => ({
    id: person.id,
    data: JSON.stringify({
      ...person,
      parents: undefined,
      spouses: undefined,
    }),
  }));
  const unions = (family.unions || []).map((union) => ({
    id: union.id,
    participantA: union.participants[0],
    participantB: union.participants[1],
    data: JSON.stringify(union),
  }));
  const relations: RelationRow[] = [];
  const spouses = new Set<string>();
  for (const person of family.people) {
    for (const parent of person.parents)
      relations.push({
        id: `parent:${parent}:${person.id}`,
        source: parent,
        target: person.id,
        type: "parent",
        note: "",
        twinKind: null,
        createdBy: null,
      });
    for (const spouse of person.spouses) {
      const pair = [person.id, spouse].sort(),
        key = JSON.stringify(pair);
      if (spouses.has(key)) continue;
      spouses.add(key);
      relations.push({
        id: `spouse:${key}`,
        source: pair[0],
        target: pair[1],
        type: "spouse",
        note: "",
        twinKind: null,
        createdBy: null,
      });
    }
  }
  for (const link of family.links || [])
    relations.push({
      id: link.id,
      source: link.from,
      target: link.to,
      type: link.type,
      note: link.note || "",
      twinKind: link.type === "twin" ? link.twinKind || "unknown" : null,
      createdBy: link.createdBy || null,
    });

  const photos: JsonRow[] = [],
    tags: TagRow[] = [];
  for (const photo of family.photos || []) {
    photos.push({
      id: photo.id,
      data: JSON.stringify({ ...photo, tags: undefined }),
    });
    for (const tag of photo.tags)
      tags.push({
        id: `${photo.id}:${tag.id}`,
        photoId: photo.id,
        personId: tag.personId,
        data: JSON.stringify(tag),
      });
  }
  return { people, unions, relations, photos, tags };
}
