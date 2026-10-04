import {
  connectPeople,
  removeConnection,
  type Connection,
  type ConnectionType,
} from "./mutations.ts";
import { owns, type ArchiveUser } from "./access.ts";
import type { ClaimConfidence, Family, Person, Source } from "./types.ts";
import { validateFamily } from "./validation.ts";

export type GraphConnection = Connection & {
  key: string;
  note?: string;
  createdBy?: string;
  sources?: Source[];
  confidence?: ClaimConfidence;
};
export function connectionKey(edge: Connection) {
  return edge.id
    ? `extra:${edge.id}`
    : encodeURIComponent(
        JSON.stringify([
          edge.type,
          ...(edge.type === "spouse"
            ? [edge.from, edge.to].sort()
            : [edge.from, edge.to]),
        ]),
      );
}
export function archiveConnections(family: Family): GraphConnection[] {
  const edges = new Map<string, GraphConnection>();
  function add(edge: Connection & { note?: string; createdBy?: string; sources?: Source[];
    confidence?: ClaimConfidence }) {
    const key = connectionKey(edge);
    edges.set(key, { ...edge, key });
  }
  for (const p of family.people) {
    for (const id of p.parents) {
      const claim = p.parentClaims?.find((item) => item.parentId === id);
      add({ from: id, to: p.id, type: "parent", sources: claim?.sources,
        confidence: claim?.confidence });
    }
    for (const id of p.spouses) {
      const [from, to] = [p.id, id].sort();
      add({ from, to, type: "spouse" });
    }
  }
  for (const edge of family.links || []) add(edge);
  return [...edges.values()];
}
/** Annotate an existing edge without changing biological parentage. */
export function setParentClaim(
  family: Family,
  parentId: string,
  childId: string,
  sources?: Source[],
  confidence?: ClaimConfidence,
) {
  const next = structuredClone(family);
  const child = next.people.find((person) => person.id === childId);
  if (!child?.parents.includes(parentId))
    throw new Error("Родительская связь уже изменена. Обновите данные.");
  const claims = (child.parentClaims || []).filter((item) => item.parentId !== parentId);
  if (sources?.length || confidence)
    claims.push({ parentId, ...(sources?.length ? { sources } : {}),
      ...(confidence ? { confidence } : {}) });
  if (claims.length || child.parentClaims !== undefined)
    child.parentClaims = claims;
  return validateFamily(next);
}
export function canChangeConnection(
  family: Family,
  user: ArchiveUser | null,
  edge: Connection,
  people?: Map<string, Person>,
) {
  const a = people
      ? people.get(edge.from)
      : family.people.find((p) => p.id === edge.from),
    b = people
      ? people.get(edge.to)
      : family.people.find((p) => p.id === edge.to);
  if (!a || !b || !owns(user, b)) return false;
  if (edge.type === "parent") return true;
  if (!owns(user, a)) return false;
  return (
    !edge.id || owns(user, family.links?.find((l) => l.id === edge.id) || {})
  );
}
/** Перенос конца и изменение типа — один снимок, без промежуточного удаления на сервере. */
export function replaceConnection(
  family: Family,
  old: GraphConnection,
  replacement: {
    from: string;
    to: string;
    type: ConnectionType;
    note?: string;
    twinKind?: Connection["twinKind"];
    sources?: Source[];
    confidence?: ClaimConfidence;
  },
) {
  const actual = archiveConnections(family).find((e) => e.key === old.key);
  if (!actual) throw new Error("Связь уже удалена. Обновите данные.");
  if (
    old.from === replacement.from &&
    old.to === replacement.to &&
    old.type === replacement.type &&
    ["parent", "spouse"].includes(old.type)
  )
    return old.type === "parent"
      ? setParentClaim(family, old.from, old.to,
        Object.hasOwn(replacement, "sources") ? replacement.sources : actual.sources,
        Object.hasOwn(replacement, "confidence") ? replacement.confidence : actual.confidence)
      : structuredClone(family);
  let next = removeConnection(family, actual);
  next = connectPeople(
    next,
    replacement.from,
    replacement.to,
    replacement.type,
    replacement.note,
    replacement.twinKind,
  );
  if (old.id && !["parent", "spouse"].includes(replacement.type)) {
    const added = next.links![next.links!.length - 1];
    added.id = old.id;
    if (old.createdBy) added.createdBy = old.createdBy;
    if (old.from === replacement.from && old.to === replacement.to &&
      old.type === replacement.type)
      added.sources = replacement.sources ?? actual.sources;
    if (old.from === replacement.from && old.to === replacement.to &&
      old.type === replacement.type)
      added.confidence = Object.hasOwn(replacement, "confidence")
        ? replacement.confidence : actual.confidence;
  }
  return next;
}
