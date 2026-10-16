import type { Family } from "./types.ts";
import { familyNeighbors } from "./family-neighborhood.ts";

export type DepthBranch = { anchorId: string; members: string[] };

/** A presentation of accessible people only; never infers or changes family links. */
export function treeDepthBranches(
  family: Pick<Family, "people" | "links" | "unions">,
  available: ReadonlySet<string>,
  anchorId: string,
) {
  const partners = new Map<string, Set<string>>();
  for (const { participants: [first, second] } of family.unions || []) {
    if (!available.has(first) || !available.has(second)) continue;
    for (const [id, partner] of [[first, second], [second, first]]) {
      if (!partners.has(id)) partners.set(id, new Set());
      partners.get(id)!.add(partner);
    }
  }
  const scoped = family.people.filter((person) => available.has(person.id))
    .map((person) => ({ ...person, spouses: [...new Set([...person.spouses, ...(partners.get(person.id) || [])])] }));
  // Extra relationships do not join otherwise separate genealogical branches.
  const index = familyNeighbors({ people: scoped, links: [] });
  const front = new Set<string>();
  const walk = (up: boolean) => {
    const seen = new Set<string>(),
      queue = [anchorId];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i],
        person = index.people.get(id);
      if (!person || seen.has(id)) continue;
      seen.add(id);
      front.add(id);
      queue.push(...(up ? person.parents : index.children.get(id) || []));
    }
  };
  walk(true);
  walk(false);
  // Preserve partners and the exact co-parents of visible children, without
  // recursively opening the ancestry/children of those partners.
  for (const id of [...front]) {
    const person = index.people.get(id)!;
    for (const partner of person.spouses)
      if (index.people.has(partner)) front.add(partner);
    for (const child of index.children.get(id) || [])
      if (front.has(child))
        for (const parent of index.people.get(child)!.parents)
          if (index.people.has(parent)) front.add(parent);
  }
  const remaining = new Set(
    scoped.map((p) => p.id).filter((id) => !front.has(id)),
  );
  const back: DepthBranch[] = [];
  for (const person of scoped) {
    if (!remaining.delete(person.id)) continue;
    const members = [person.id];
    for (let i = 0; i < members.length; i++)
      for (const id of index.neighbors.get(members[i]) || [])
        if (remaining.delete(id)) members.push(id);
    // Prefer the boundary person that actually connects this branch to the front.
    const anchor =
      members.find((id) =>
        [...(index.neighbors.get(id) || [])].some((near) => front.has(near)),
      ) || members[0];
    back.push({ anchorId: anchor, members });
  }
  return { front, back };
}
