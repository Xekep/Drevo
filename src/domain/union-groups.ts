import type { EdgeRoute } from "./edge-routing.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";

export type FamilyUnion = {
  id: string;
  members: string[];
  children: string[];
  married: boolean;
};
export type UnionGroup = {
  id: string;
  members: string[];
  families: FamilyUnion[];
};

/** Общее размещение не объединяет факты разных браков и списки их детей. */
export function groupFamilyUnions(
  families: FamilyUnion[],
  levels: ReadonlyMap<string, number>,
): UnionGroup[] {
  const owners = new Map(families.map((f) => [f.id, f.id]));
  const find = (id: string): string => {
    let root = id;
    while (owners.get(root) !== root) root = owners.get(root)!;
    while (id !== root) {
      const next = owners.get(id)!;
      owners.set(id, root);
      id = next;
    }
    return root;
  };
  const shared = new Map<string, string>();
  for (const family of families) {
    const rank = levels.get(family.members[0]) || 0;
    // Родственные браки разных поколений сохраняют отдельные отображения.
    if (family.members.some((id) => (levels.get(id) || 0) !== rank)) continue;
    for (const id of family.members) {
      const key = JSON.stringify([rank, id]),
        previous = shared.get(key);
      if (previous) owners.set(find(family.id), find(previous));
      else shared.set(key, family.id);
    }
  }
  const groups = new Map<string, FamilyUnion[]>();
  for (const family of families) {
    const key = find(family.id),
      group = groups.get(key) || [];
    group.push(family);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      id:
        group.length === 1
          ? group[0].id
          : `unions:${JSON.stringify(group.map((f) => f.id).sort())}`,
      members: partnerOrder(group),
      families: group,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Общая персона в центре; следующие партнёры занимают обе стороны. */
function partnerOrder(families: FamilyUnion[]) {
  const ids = [...new Set(families.flatMap((f) => f.members))].sort();
  if (ids.length <= 2) return ids;
  const adjacent = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const family of families)
    for (const a of family.members)
      for (const b of family.members) if (a !== b) adjacent.get(a)!.add(b);
  const anchor = [...ids].sort(
    (a, b) =>
      adjacent.get(b)!.size - adjacent.get(a)!.size || a.localeCompare(b),
  )[0];
  let order = [anchor];
  const remaining = new Set(ids.filter((id) => id !== anchor));
  const cost = (row: string[]) => {
    const at = new Map(row.map((id, i) => [id, i]));
    let score = Math.abs(2 * at.get(anchor)! - row.length + 1) * 0.1;
    for (const family of families) {
      const positions = family.members
        .filter((id) => at.has(id))
        .map((id) => at.get(id)!);
      if (positions.length > 1)
        score += Math.max(...positions) - Math.min(...positions);
    }
    return score;
  };
  while (remaining.size) {
    const connected = (id: string) =>
      [...adjacent.get(id)!].filter((p) => !remaining.has(p)).length;
    const next = [...remaining].sort(
      (a, b) =>
        connected(b) - connected(a) ||
        adjacent.get(b)!.size - adjacent.get(a)!.size ||
        a.localeCompare(b),
    )[0];
    const left = [next, ...order],
      right = [...order, next];
    order = cost(left) <= cost(right) ? left : right;
    remaining.delete(next);
  }
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let i = 1; i < order.length; i++) {
      const candidate = [...order];
      [candidate[i - 1], candidate[i]] = [candidate[i], candidate[i - 1]];
      if (cost(candidate) < cost(order)) {
        order = candidate;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return order;
}

export type LocalUnion = {
  family: FamilyUnion;
  joint: { x: number; y: number };
  pair?: EdgeRoute;
};

/** У каждого союза свой выход к детям, даже при общей карточке родителя. */
export function localUnionRoutes(group: UnionGroup, size: TreeNodeSize) {
  const { width: W, height: H } = size;
  const x = new Map(group.members.map((id, i) => [id, i * (W + 32)]));
  const degree = new Map(
    group.members.map((id) => [
      id,
      group.families.filter(
        (f) => f.members.length > 1 && f.members.includes(id),
      ).length,
    ]),
  );
  let lane = 0;
  const families: LocalUnion[] = group.families.map((family) => {
    const [a, b] = family.members;
    if (!b) return { family, joint: { x: x.get(a)! + W / 2, y: H } };
    const left = Math.min(...family.members.map((id) => x.get(id)!));
    const right = Math.max(...family.members.map((id) => x.get(id)!));
    const forward = x.get(a)! === left;
    if (right - left === W + 32) {
      const points = [
        { x: left + W, y: H / 2 },
        { x: right, y: H / 2 },
      ];
      return {
        family,
        joint: { x: left + W + 16, y: H / 2 },
        pair: {
          sourceHandle: forward ? "right" : "left",
          targetHandle: forward ? "left" : "right",
          points: forward ? points : points.reverse(),
        },
      };
    }
    // Третий и последующие партнёры соединяются отдельными дорожками под
    // карточками. Эти дорожки резервируются в размере узла до запуска ELK.
    const y = H + ++lane * 16;
    const points = [
      { x: left + W / 2, y: H },
      { x: left + W / 2, y },
      { x: right + W / 2, y },
      { x: right + W / 2, y: H },
    ];
    return {
      family,
      joint: {
        x:
          degree.get(a)! > degree.get(b)!
            ? forward
              ? right - 16
              : left + W + 16
            : forward
              ? left + W + 16
              : right - 16,
        y,
      },
      pair: {
        sourceHandle: "bottom",
        targetHandle: "bottom",
        points: forward ? points : points.reverse(),
      },
    };
  });
  return { families, bottom: lane * 16 };
}
