import {
  connectPeople,
  removeConnection,
  type Connection,
  type ConnectionType,
} from "./mutations.ts";
import { owns, type ArchiveUser } from "./access.ts";
import type { Family, Person } from "./types.ts";

export type GraphConnection = Connection & {
  key: string;
  note?: string;
  createdBy?: string;
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
  function add(edge: Connection & { note?: string; createdBy?: string }) {
    const key = connectionKey(edge);
    edges.set(key, { ...edge, key });
  }
  for (const p of family.people) {
    for (const id of p.parents) add({ from: id, to: p.id, type: "parent" });
    for (const id of p.spouses) {
      const [from, to] = [p.id, id].sort();
      add({ from, to, type: "spouse" });
    }
  }
  for (const edge of family.links || []) add(edge);
  return [...edges.values()];
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
    return structuredClone(family);
  let next = removeConnection(family, actual);
  next = connectPeople(
    next,
    replacement.from,
    replacement.to,
    replacement.type,
    replacement.note,
  );
  if (old.id && !["parent", "spouse"].includes(replacement.type)) {
    const added = next.links![next.links!.length - 1];
    added.id = old.id;
    if (old.createdBy) added.createdBy = old.createdBy;
  }
  return next;
}
